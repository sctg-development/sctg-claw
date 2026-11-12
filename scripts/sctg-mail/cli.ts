#!/usr/bin/env node
// Command line over the same delivery path as the send_email tool (gog, then the SMTP and Cloudflare
// fallbacks), for shell scripts and other plugins:
//
//   node /opt/sctg-mail/dist/cli.js send --to a@x.org,b@x.org --subject "..." \
//        [--account sender@x.org] [--html-file F|-] [--text-file F|-] [--dry-run]
//
// `-` reads the body from stdin. The sender defaults to $SCTG_MAIL_ACCOUNT. Exit codes: 0 delivered
// (possibly by a fallback: the line on stderr says so), 1 not delivered, 2 usage or validation error.
import { readFileSync } from "node:fs";
import { makeGogSender } from "./gog-send.js";
import { validateMail } from "./mail.js";
import { fallbackConfigFromEnv, nodemailerSmtpSend, sendWithFallback } from "./transports.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const read = (source: string | undefined) => (source ? readFileSync(source === "-" ? 0 : source, "utf8") : undefined);

async function main(): Promise<number> {
  if (argv[0] !== "send" || !flag("to") || !flag("subject")) {
    console.error("usage: cli.js send --to <a,b> --subject <s> [--account <a>] [--html-file F|-] [--text-file F|-] [--dry-run]");
    return 2;
  }
  const account = flag("account") ?? process.env.SCTG_MAIL_ACCOUNT;
  const validation = validateMail(
    {
      to: flag("to")!,
      subject: flag("subject")!,
      bodyHtml: read(flag("html-file")),
      bodyText: read(flag("text-file")),
      account,
      dryRun: argv.includes("--dry-run"),
    },
    { defaultAccount: account, allowedAccounts: account ? [account] : [], maxRecipients: 20 },
  );
  if (!validation.ok) {
    console.error(`sctg-mail: refused: ${validation.error}`);
    return 2;
  }
  const result = await sendWithFallback(validation.mail, fallbackConfigFromEnv(process.env), {
    sendViaGog: makeGogSender({ gogBinary: process.env.GOG_BIN || "gog", env: process.env }),
    smtpSend: nodemailerSmtpSend,
    fetch,
  });
  if (!result.ok) {
    console.error(`sctg-mail: NOT delivered: ${result.error}`);
    return 1;
  }
  console.error(
    result.degraded
      ? `sctg-mail: delivered via ${result.transport} (DEGRADED: gog failed: ${result.attempts[0]?.detail ?? "unknown"})`
      : `sctg-mail: delivered via ${result.transport}`,
  );
  return 0;
}

process.exitCode = await main();
