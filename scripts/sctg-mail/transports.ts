// Delivery with fallback: gog (Gmail API) first, then Gmail SMTP, then Cloudflare Email Sending.
//
// Why: gog depends on a Google OAuth refresh token, which can expire or be revoked. An alert sent through
// the very channel that is broken is lost, so two independent channels back it up. Every I/O dependency is
// injected so the logic is testable without network or accounts.
//
// Fallbacks are deliberately NARROW: they only send when EVERY recipient is on the configured allow-list
// (ALERT_FALLBACK_RECIPIENTS), so an app password or an API token can never be used to mail arbitrary
// addresses. A fallback message states that the main channel failed, so a broken token stays visible.
// Secrets (SMTP password, Cloudflare token) come from the environment only and never reach a log, an
// error message, or a result.
import type { ValidatedMail } from "./mail.js";

export type TransportName = "gog" | "smtp" | "cloudflare";

export type Attempt = { transport: TransportName; ok: boolean; detail?: string };

export type SendResult = {
  ok: boolean;
  /** The transport that delivered, when ok. */
  transport?: TransportName;
  attempts: Attempt[];
  /** True when a fallback delivered: the main channel is degraded. */
  degraded: boolean;
  error?: string;
};

export type FallbackConfig = {
  recipients: string[];
  smtp?: { host: string; port: number; user: string; password: string; from: string };
  cloudflare?: { accountId: string; token: string; from: string; fromName?: string };
};

/** Builds the fallback configuration from the environment. Incomplete groups are treated as absent. */
export function fallbackConfigFromEnv(env: NodeJS.ProcessEnv): FallbackConfig {
  const recipients = (env.ALERT_FALLBACK_RECIPIENTS ?? "")
    .split(/[,;\s]+/)
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const config: FallbackConfig = { recipients };
  const smtpUser = env.ALERT_SMTP_USER?.trim();
  const smtpPassword = env.ALERT_SMTP_PASSWORD;
  if (smtpUser && smtpPassword) {
    config.smtp = {
      host: env.ALERT_SMTP_HOST?.trim() || "smtp.gmail.com",
      port: Number(env.ALERT_SMTP_PORT) || 587,
      user: smtpUser,
      password: smtpPassword,
      // Gmail rewrites the From header to the authenticated account unless a send-as alias exists.
      from: env.ALERT_SMTP_FROM?.trim() || smtpUser,
    };
  }
  const cfToken = env.CLOUDFLARE_EMAIL_API_TOKEN;
  const cfAccount = env.CLOUDFLARE_EMAIL_ACCOUNT_ID?.trim();
  const cfFrom = env.CLOUDFLARE_EMAIL_FROM?.trim();
  if (cfToken && cfAccount && cfFrom) {
    config.cloudflare = {
      accountId: cfAccount,
      token: cfToken,
      from: cfFrom,
      fromName: env.CLOUDFLARE_EMAIL_FROM_NAME?.trim() || undefined,
    };
  }
  return config;
}

/** Pure: are all recipients on the allow-list? An empty allow-list means "fallbacks disabled". */
export function recipientsAllowed(mail: ValidatedMail, allowed: string[]): boolean {
  if (allowed.length === 0) {
    return false;
  }
  const set = new Set(allowed);
  return [...mail.to, ...mail.cc, ...mail.bcc].every((r) => set.has(r.toLowerCase()));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pure: the notice added to a message delivered by a fallback. */
export function withFallbackNotice(
  mail: ValidatedMail,
  channel: string,
  reason: string,
): { html?: string; text?: string } {
  const short = reason.replace(/\s+/g, " ").trim().slice(0, 200);
  const text = `[Envoi de secours via ${channel}] Le canal principal (gog) a échoué : ${short}`;
  return {
    html: mail.bodyHtml
      ? `<p style="background:#fff3cd;border:1px solid #e0c46c;padding:8px;font-size:90%"><b>Envoi de secours via ${escapeHtml(channel)}.</b> Le canal principal (gog) a échoué : ${escapeHtml(short)}</p>${mail.bodyHtml}`
      : undefined,
    text: mail.bodyText ? `${text}\n\n${mail.bodyText}` : mail.bodyHtml ? undefined : text,
  };
}

export type SmtpMessage = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html?: string;
  text?: string;
};

export type Deps = {
  /** Runs gog for this mail. Resolves with ok=false and a reason instead of throwing. */
  sendViaGog: (mail: ValidatedMail) => Promise<{ ok: boolean; reason: string }>;
  /** Sends one SMTP message. Rejects on failure. */
  smtpSend: (cfg: NonNullable<FallbackConfig["smtp"]>, message: SmtpMessage) => Promise<void>;
  fetch: typeof fetch;
};

// Error text may echo secrets (an SMTP server echoing credentials is unlikely, a proxy could): scrub the
// configured secrets from anything that leaves this module.
function scrub(text: string, config: FallbackConfig): string {
  let out = text;
  for (const secret of [config.smtp?.password, config.cloudflare?.token]) {
    if (secret) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function viaCloudflare(
  cfg: NonNullable<FallbackConfig["cloudflare"]>,
  mail: ValidatedMail,
  body: { html?: string; text?: string },
  doFetch: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  const payload: Record<string, unknown> = {
    to: mail.to,
    from: cfg.fromName ? { address: cfg.from, name: cfg.fromName } : cfg.from,
    subject: mail.subject,
    ...(mail.cc.length ? { cc: mail.cc } : {}),
    ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
    ...(body.html ? { html: body.html } : {}),
    ...(body.text ? { text: body.text } : {}),
  };
  const response = await doFetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/email/sending/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: { message?: string }[];
    result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] };
  };
  if (!response.ok || json.success === false) {
    return { ok: false, detail: `HTTP ${response.status} ${json.errors?.[0]?.message ?? ""}`.trim() };
  }
  const accepted = [...(json.result?.delivered ?? []), ...(json.result?.queued ?? [])];
  if (accepted.length === 0) {
    return { ok: false, detail: "accepted by the API but nothing delivered or queued" };
  }
  return { ok: true, detail: `${accepted.length} recipient(s)` };
}

export async function sendWithFallback(
  mail: ValidatedMail,
  config: FallbackConfig,
  deps: Deps,
): Promise<SendResult> {
  const attempts: Attempt[] = [];
  const gog = await deps.sendViaGog(mail);
  if (gog.ok) {
    return { ok: true, transport: "gog", attempts: [{ transport: "gog", ok: true }], degraded: false };
  }
  attempts.push({ transport: "gog", ok: false, detail: scrub(gog.reason, config) });
  if (mail.dryRun) {
    return { ok: false, attempts, degraded: false, error: attempts[0]!.detail };
  }

  const candidates = [config.smtp ? "smtp" : undefined, config.cloudflare ? "cloudflare" : undefined].filter(
    Boolean,
  ) as TransportName[];
  if (candidates.length === 0) {
    return { ok: false, attempts, degraded: false, error: attempts[0]!.detail };
  }
  if (!recipientsAllowed(mail, config.recipients)) {
    attempts.push({
      transport: candidates[0]!,
      ok: false,
      detail: "fallback skipped: a recipient is not in ALERT_FALLBACK_RECIPIENTS",
    });
    return { ok: false, attempts, degraded: false, error: attempts.map((a) => `${a.transport}: ${a.detail}`).join(" | ") };
  }

  for (const transport of candidates) {
    try {
      if (transport === "smtp" && config.smtp) {
        const notice = withFallbackNotice(mail, "SMTP Gmail", gog.reason);
        await deps.smtpSend(config.smtp, {
          from: config.smtp.from,
          to: mail.to,
          cc: mail.cc,
          bcc: mail.bcc,
          subject: mail.subject,
          ...notice,
        });
        attempts.push({ transport, ok: true });
        return { ok: true, transport, attempts, degraded: true };
      }
      if (transport === "cloudflare" && config.cloudflare) {
        const notice = withFallbackNotice(mail, "Cloudflare Email Sending", gog.reason);
        const result = await viaCloudflare(config.cloudflare, mail, notice, deps.fetch);
        attempts.push({ transport, ok: result.ok, detail: scrub(result.detail, config) });
        if (result.ok) {
          return { ok: true, transport, attempts, degraded: true };
        }
      }
    } catch (error) {
      attempts.push({ transport, ok: false, detail: scrub((error as Error).message, config) });
    }
  }
  return {
    ok: false,
    attempts,
    degraded: false,
    error: attempts.map((a) => `${a.transport}: ${a.detail ?? "ok"}`).join(" | "),
  };
}

/** Real SMTP send (nodemailer, loaded lazily so tests and the gog path never need it). */
export async function nodemailerSmtpSend(
  cfg: NonNullable<FallbackConfig["smtp"]>,
  message: SmtpMessage,
): Promise<void> {
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: { user: cfg.user, pass: cfg.password },
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transporter.sendMail(message);
  } finally {
    transporter.close();
  }
}
