import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMail } from "./mail.ts";
import {
  fallbackConfigFromEnv,
  recipientsAllowed,
  sendWithFallback,
  withFallbackNotice,
  type Deps,
  type FallbackConfig,
  type SmtpMessage,
} from "./transports.ts";

const cfgBase = { defaultAccount: "sender@example.org", maxRecipients: 5 };
function mail(over: Record<string, unknown> = {}) {
  const v = validateMail({ to: ["ops@example.org"], subject: "Alert", bodyText: "body", bodyHtml: "<p>body</p>", ...over }, cfgBase);
  assert.ok(v.ok);
  return v.mail;
}
const SMTP = { host: "smtp.example.org", port: 587, user: "agent@example.org", password: "app-pass-123", from: "agent@example.org" };
const CF = { accountId: "acc1", token: "cf-token-xyz", from: "alerts@alerts.example.org", fromName: "alerts" };
const ALL: FallbackConfig = { recipients: ["ops@example.org"], smtp: SMTP, cloudflare: CF };

function deps(over: Partial<Deps> & { calls?: string[] } = {}): Deps & { calls: string[]; smtp: SmtpMessage[]; cf: any[] } {
  const calls: string[] = [];
  const smtp: SmtpMessage[] = [];
  const cf: any[] = [];
  return {
    calls,
    smtp,
    cf,
    sendViaGog: over.sendViaGog ?? (async () => (calls.push("gog"), { ok: true, reason: "" })),
    smtpSend: over.smtpSend ?? (async (_c, m) => void (calls.push("smtp"), smtp.push(m))),
    fetch:
      over.fetch ??
      ((async (url: string, init: any) => {
        calls.push("cloudflare");
        cf.push({ url, init });
        return new Response(JSON.stringify({ success: true, result: { delivered: ["ops@example.org"] } }), { status: 200 });
      }) as unknown as typeof fetch),
  };
}
const gogDown = async () => ({ ok: false, reason: "Google refused the stored token (invalid_grant)" });

test("env: groups are only enabled when complete, recipients are normalised", () => {
  assert.deepEqual(fallbackConfigFromEnv({}), { recipients: [] });
  const c = fallbackConfigFromEnv({
    ALERT_FALLBACK_RECIPIENTS: " Ops@Example.org; b@example.org ",
    ALERT_SMTP_USER: "a@example.org",
    ALERT_SMTP_PASSWORD: "pw",
    CLOUDFLARE_EMAIL_API_TOKEN: "t",
    CLOUDFLARE_EMAIL_ACCOUNT_ID: "acc",
  });
  assert.deepEqual(c.recipients, ["ops@example.org", "b@example.org"]);
  assert.equal(c.smtp?.host, "smtp.gmail.com");
  assert.equal(c.smtp?.port, 587);
  assert.equal(c.smtp?.from, "a@example.org");
  assert.equal(c.cloudflare, undefined, "no from address: group incomplete");
});

test("gog works: no fallback is touched", async () => {
  const d = deps();
  const r = await sendWithFallback(mail(), ALL, d);
  assert.deepEqual([r.ok, r.transport, r.degraded], [true, "gog", false]);
  assert.deepEqual(d.calls, ["gog"]);
});

test("gog down: SMTP delivers, degraded, with a visible notice and the reason", async () => {
  const d = deps({ sendViaGog: gogDown });
  const r = await sendWithFallback(mail(), ALL, d);
  assert.deepEqual([r.ok, r.transport, r.degraded], [true, "smtp", true]);
  assert.deepEqual(d.calls, ["smtp"], "Cloudflare must not run when SMTP delivered");
  assert.equal(d.smtp[0]!.from, "agent@example.org");
  assert.match(d.smtp[0]!.html!, /Envoi de secours via SMTP Gmail/);
  assert.match(d.smtp[0]!.text!, /invalid_grant/);
  assert.match(d.smtp[0]!.html!, /<p>body<\/p>$/);
});

test("gog and SMTP down: Cloudflare delivers with the REST shape the API expects", async () => {
  const d = deps({ sendViaGog: gogDown, smtpSend: async () => { throw new Error("535 auth failed"); } });
  const r = await sendWithFallback(mail({ cc: ["c@example.org"] }), { ...ALL, recipients: ["ops@example.org", "c@example.org"] }, d);
  assert.deepEqual([r.ok, r.transport, r.degraded], [true, "cloudflare", true]);
  const { url, init } = d.cf[0];
  assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/acc1/email/sending/send");
  assert.equal(init.headers.Authorization, "Bearer cf-token-xyz");
  const body = JSON.parse(init.body);
  assert.deepEqual(body.from, { address: "alerts@alerts.example.org", name: "alerts" }, "REST uses `address`, not `email`");
  assert.deepEqual(body.to, ["ops@example.org"]);
  assert.deepEqual(body.cc, ["c@example.org"]);
  assert.match(body.html, /Envoi de secours via Cloudflare/);
  assert.deepEqual(r.attempts.map((a) => [a.transport, a.ok]), [["gog", false], ["smtp", false], ["cloudflare", true]]);
});

test("fallbacks only send to allow-listed recipients; otherwise nothing is sent and why is reported", async () => {
  const d = deps({ sendViaGog: gogDown });
  const r = await sendWithFallback(mail({ to: ["ops@example.org", "stranger@example.org"] }), ALL, d);
  assert.equal(r.ok, false);
  assert.deepEqual(d.calls, [], "no fallback may run");
  assert.match(r.attempts.at(-1)!.detail!, /not in ALERT_FALLBACK_RECIPIENTS/);
  assert.match(r.error!, /invalid_grant.*fallback skipped/, "the error must say why no fallback ran");
  assert.equal(recipientsAllowed(mail(), []), false, "an empty allow-list disables the fallbacks");
  assert.equal(recipientsAllowed(mail({ to: ["OPS@example.org"] }), ["ops@example.org"]), true, "case-insensitive");
});

test("no fallback configured: the gog failure is returned as is", async () => {
  const r = await sendWithFallback(mail(), { recipients: ["ops@example.org"] }, deps({ sendViaGog: gogDown }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /invalid_grant/);
});

test("everything down: every attempt is reported", async () => {
  const d = deps({
    sendViaGog: gogDown,
    smtpSend: async () => { throw new Error("connect ETIMEDOUT"); },
    fetch: (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Unauthorized" }] }), { status: 401 })) as unknown as typeof fetch,
  });
  const r = await sendWithFallback(mail(), ALL, d);
  assert.equal(r.ok, false);
  assert.deepEqual(r.attempts.map((a) => a.transport), ["gog", "smtp", "cloudflare"]);
  assert.match(r.error!, /smtp: connect ETIMEDOUT \| cloudflare: HTTP 401 Unauthorized/);
});

test("secrets never leak into results, even when a server echoes them", async () => {
  const d = deps({
    sendViaGog: gogDown,
    smtpSend: async () => { throw new Error("rejected password app-pass-123 for agent"); },
    fetch: (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "bad token cf-token-xyz" }] }), { status: 400 })) as unknown as typeof fetch,
  });
  const r = await sendWithFallback(mail(), ALL, d);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes("app-pass-123") && !dump.includes("cf-token-xyz"));
  assert.match(dump, /\[redacted\]/);
});

test("Cloudflare accepted-but-nothing-delivered is a failure, not a success", async () => {
  const d = deps({
    sendViaGog: gogDown,
    smtpSend: async () => { throw new Error("down"); },
    fetch: (async () => new Response(JSON.stringify({ success: true, result: { delivered: [], queued: [], permanent_bounces: ["ops@example.org"] } }), { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal((await sendWithFallback(mail(), ALL, d)).ok, false);
});

test("a dry run never falls back", async () => {
  const d = deps({ sendViaGog: gogDown });
  const r = await sendWithFallback(mail({ dryRun: true }), ALL, d);
  assert.equal(r.ok, false);
  assert.deepEqual(d.calls, []);
});

test("notice escapes HTML in the failure reason and keeps text-only mails text-only", () => {
  const m = mail({ bodyHtml: undefined });
  const n = withFallbackNotice(m, "SMTP Gmail", "<script>x</script>");
  assert.equal(n.html, undefined);
  const h = withFallbackNotice(mail(), "SMTP Gmail", "<script>x</script>");
  assert.ok(!h.html!.includes("<script>x"));
});
