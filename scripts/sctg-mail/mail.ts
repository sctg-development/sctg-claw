// Pure logic of the send_email tool: validation and gog argument construction.
// No I/O here so it can be unit-tested without gog, Google, or the OpenClaw SDK.

export type MailConfig = {
  gogBinary?: string;
  defaultAccount?: string;
  allowedAccounts?: string[];
  maxRecipients?: number;
  requireApproval?: boolean;
  /** Folders inline images may be read from. Defaults to the coach plugin's charts folder. */
  inlineImageRoots?: string[];
};

/** An image to show inside the HTML body as <img src="cid:CID">. */
export type InlineImage = { cid: string; path: string };
export type LoadedImage = { cid: string; filename: string; contentType: "image/png" | "image/jpeg"; content: Buffer };

export type SendEmailInput = {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  account?: string;
  dryRun?: boolean;
  inlineImages?: InlineImage[];
};

export const DEFAULT_MAX_RECIPIENTS = 20;
export const MAX_INLINE_IMAGES = 8;
export const CID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SUBJECT_LENGTH = 300;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Deliberately conservative: no display names, no quoting, no comments. gog gets
// bare addresses only, so nothing in an address can become a flag or a header.
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** Accepts ["a@x.org","b@y.org"] or "a@x.org, b@y.org" (spaces tolerated, unlike the shell). */
export function normalizeAddresses(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const parts = Array.isArray(value) ? value : value.split(/[,;]/);
  return parts
    .flatMap((part) => part.split(/[,;]/))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export type ValidatedMail = {
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  dryRun: boolean;
  /** Requested inline images (paths); loaded into `images` by withLoadedImages. */
  inlineImages: InlineImage[];
  images: LoadedImage[];
};

/** Shape checks only (no file access): safe to run inside the pure validation step. */
export function validateInlineRequests(value: unknown, bodyHtml: string | undefined): { ok: true; images: InlineImage[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, images: [] };
  if (!Array.isArray(value)) return { ok: false, error: "inlineImages must be an array of { cid, path }" };
  if (value.length > MAX_INLINE_IMAGES) return { ok: false, error: `too many inline images (max ${MAX_INLINE_IMAGES})` };
  if (value.length > 0 && !bodyHtml) return { ok: false, error: "inlineImages need bodyHtml" };
  const seen = new Set<string>();
  const images: InlineImage[] = [];
  for (const item of value as Array<{ cid?: unknown; path?: unknown }>) {
    const cid = typeof item?.cid === "string" ? item.cid : "";
    const file = typeof item?.path === "string" ? item.path : "";
    if (!CID.test(cid)) return { ok: false, error: `invalid inline image cid ${JSON.stringify(cid)} (letters, digits, . _ -; max 64)` };
    if (seen.has(cid)) return { ok: false, error: `duplicate inline image cid ${JSON.stringify(cid)}` };
    if (!file || file.includes("\0") || !/\.(png|jpe?g)$/i.test(file)) return { ok: false, error: `inline image ${cid}: path must be a .png or .jpg file` };
    if (!bodyHtml?.includes(`cid:${cid}`)) return { ok: false, error: `inline image ${cid} is not referenced in bodyHtml (expected src="cid:${cid}")` };
    seen.add(cid);
    images.push({ cid, path: file });
  }
  return { ok: true, images };
}


export type Validation = { ok: true; mail: ValidatedMail } | { ok: false; error: string };

export function validateMail(input: SendEmailInput, config: MailConfig): Validation {
  const account = (input.account ?? config.defaultAccount ?? "").trim();
  if (!account) {
    return { ok: false, error: "no sender account: pass `account` or configure defaultAccount" };
  }
  const allowed = new Set(
    (config.allowedAccounts?.length ? config.allowedAccounts : config.defaultAccount ? [config.defaultAccount] : []).map(
      (a) => a.trim().toLowerCase(),
    ),
  );
  if (!allowed.has(account.toLowerCase())) {
    return { ok: false, error: `sender account ${account} is not in allowedAccounts` };
  }

  const to = normalizeAddresses(input.to);
  const cc = normalizeAddresses(input.cc);
  const bcc = normalizeAddresses(input.bcc);
  if (to.length === 0) {
    return { ok: false, error: "at least one `to` recipient is required" };
  }
  const max = config.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  if (to.length + cc.length + bcc.length > max) {
    return { ok: false, error: `too many recipients (max ${max})` };
  }
  for (const address of [...to, ...cc, ...bcc]) {
    if (!EMAIL.test(address)) {
      return { ok: false, error: `invalid recipient address: ${JSON.stringify(address)}` };
    }
  }

  const subject = (input.subject ?? "").trim();
  if (!subject) {
    return { ok: false, error: "subject is required" };
  }
  if (/[\r\n]/.test(subject)) {
    return { ok: false, error: "subject must be a single line" };
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return { ok: false, error: `subject too long (max ${MAX_SUBJECT_LENGTH} characters)` };
  }

  const bodyHtml = input.bodyHtml?.trim() ? input.bodyHtml : undefined;
  const bodyText = input.bodyText?.trim() ? input.bodyText : undefined;
  if (!bodyHtml && !bodyText) {
    return { ok: false, error: "provide bodyHtml or bodyText" };
  }
  for (const body of [bodyHtml, bodyText]) {
    if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return { ok: false, error: "body too large (max 2 MiB)" };
    }
  }

  const inline = validateInlineRequests(input.inlineImages, bodyHtml);
  if (!inline.ok) {
    return { ok: false, error: inline.error };
  }

  return {
    ok: true,
    mail: { account, to, cc, bcc, subject, bodyHtml, bodyText, dryRun: input.dryRun === true, inlineImages: inline.images, images: [] },
  };
}

/**
 * gog argv. Restricted to the single `gmail.send` command so even a prompt-injected agent
 * cannot use this tool to read mail, and `--no-input` so it can never hang on a prompt.
 * Bodies are passed as files (never inline) to avoid argv size limits and quoting issues.
 */
export function buildGogArgs(
  mail: ValidatedMail,
  files: { htmlFile?: string; textFile?: string; rawFile?: string },
): string[] {
  const args = [
    "--account",
    mail.account,
    "--enable-commands-exact",
    "gmail.send",
    "--no-input",
    ...(mail.dryRun ? ["--dry-run"] : []),
    "gmail",
    "send",
  ];
  if (files.rawFile) {
    // The complete message (headers, recipients, inline images) is in the file; gog refuses to mix it with compose flags.
    args.push("--raw-file", files.rawFile);
    return args;
  }
  args.push("--to", mail.to.join(","), "--subject", mail.subject);
  if (mail.cc.length > 0) {
    args.push("--cc", mail.cc.join(","));
  }
  if (mail.bcc.length > 0) {
    args.push("--bcc", mail.bcc.join(","));
  }
  if (files.htmlFile) {
    args.push("--body-html-file", files.htmlFile);
  }
  if (files.textFile) {
    args.push("--body-file", files.textFile);
  }
  return args;
}

/** Maps gog's failure output to something the agent (and the operator email) can act on. */
export function explainGogFailure(stderr: string): string {
  const text = stderr.trim();
  if (/invalid_grant|token.*(expired|revoked)|refresh token|reauth|authorization.*required/i.test(text)) {
    return (
      `Google refused the stored token (${text.split("\n")[0]}). The OAuth app is probably still in ` +
      "\"Testing\" status (refresh tokens expire after 7 days) or the token was revoked: re-authorize the " +
      "account with gog auth add, and publish the OAuth app to \"In production\"."
    );
  }
  return text.split("\n").slice(0, 3).join(" | ") || "gog exited with an error and no message";
}
