import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGogArgs, explainGogFailure, validateMail, type MailConfig } from "./mail.js";

const SEND_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

type Outcome = { code: number; stdout: string; stderr: string };

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: SEND_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, env }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolve({ code, stdout, stderr: stderr || error.message });
    });
  });
}

const Addresses = Type.Union([Type.String(), Type.Array(Type.String())], {
  description: "One address, a comma-separated string, or an array of addresses. Bare addresses only (no display names).",
});

export default definePluginEntry({
  id: "sctg-mail",
  name: "SCTG Mail",
  description: "One safe send_email tool backed by the gog CLI.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as MailConfig;
    const gogBinary = cfg.gogBinary?.trim() || "gog";
    // Same convention as the existing automations: an empty keyring password unless the chart sets one.
    const env: NodeJS.ProcessEnv = { ...process.env, GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD ?? "" };

    api.registerTool({
      name: "send_email",
      label: "Send Email",
      description:
        "Sends one email through Gmail using the gog CLI. Send-only: it cannot read or search mail. " +
        "Use this instead of running `gog gmail send` by hand. Provide `to` (several addresses allowed), " +
        "`subject`, and `bodyHtml` and/or `bodyText`. The sender is the configured default account unless " +
        "`account` names another allow-listed one. Returns ok:false with an explanation on failure, " +
        "including the case where Google has expired the account's token.",
      parameters: Type.Object(
        {
          to: Addresses,
          cc: Type.Optional(Addresses),
          bcc: Type.Optional(Addresses),
          subject: Type.String({ description: "Single-line subject." }),
          bodyHtml: Type.Optional(Type.String({ description: "HTML body." })),
          bodyText: Type.Optional(Type.String({ description: "Plain-text body (used alone or as the text alternative)." })),
          account: Type.Optional(Type.String({ description: "Sender account; must be allow-listed. Defaults to the configured one." })),
          dryRun: Type.Optional(Type.Boolean({ description: "Validate and print what would be sent, without sending." })),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object(
        { ok: Type.Boolean(), account: Type.Optional(Type.String()), recipients: Type.Optional(Type.Number()), error: Type.Optional(Type.String()), output: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      async execute(_id, rawParams) {
        const validation = validateMail(rawParams as Parameters<typeof validateMail>[0], cfg);
        if (!validation.ok) {
          return {
            content: [{ type: "text", text: `send_email refused: ${validation.error}` }],
            details: { ok: false, error: validation.error },
          };
        }
        const { mail } = validation;
        const dir = await mkdtemp(path.join(tmpdir(), "sctg-mail-"));
        try {
          const files: { htmlFile?: string; textFile?: string } = {};
          if (mail.bodyHtml) {
            files.htmlFile = path.join(dir, "body.html");
            await writeFile(files.htmlFile, mail.bodyHtml, { mode: 0o600 });
          }
          if (mail.bodyText) {
            files.textFile = path.join(dir, "body.txt");
            await writeFile(files.textFile, mail.bodyText, { mode: 0o600 });
          }
          const result = await run(gogBinary, buildGogArgs(mail, files), env);
          const recipients = mail.to.length + mail.cc.length + mail.bcc.length;
          if (result.code !== 0) {
            const error = explainGogFailure(result.stderr || result.stdout);
            return {
              content: [{ type: "text", text: `send_email failed from ${mail.account}: ${error}` }],
              details: { ok: false, account: mail.account, recipients, error },
            };
          }
          const verb = mail.dryRun ? "validated (dry run, nothing sent)" : "sent";
          return {
            content: [{ type: "text", text: `Email ${verb} from ${mail.account} to ${recipients} recipient(s).` }],
            details: { ok: true, account: mail.account, recipients, output: result.stdout.trim().slice(0, 500) },
          };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    });

    if (cfg.requireApproval === true) {
      api.on("before_tool_call", async (event) => {
        if (event.toolName !== "send_email") {
          return undefined;
        }
        return {
          requireApproval: {
            title: "Send email",
            description: `Send "${String((event.params as { subject?: unknown })?.subject ?? "")}"`,
            severity: "warning" as const,
            allowedDecisions: ["allow-once", "allow-always", "deny"] as const,
          },
        };
      });
    }
  },
});
