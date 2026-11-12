import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { makeGogSender } from "./gog-send.js";
import { validateMail, type MailConfig } from "./mail.js";
import { fallbackConfigFromEnv, nodemailerSmtpSend, sendWithFallback } from "./transports.js";

const Addresses = Type.Union([Type.String(), Type.Array(Type.String())], {
  description: "One address, a comma-separated string, or an array of addresses. Bare addresses only (no display names).",
});

export default definePluginEntry({
  id: "sctg-mail",
  name: "SCTG Mail",
  description: "One safe send_email tool backed by the gog CLI.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as MailConfig;
    const sendViaGog = makeGogSender({ gogBinary: cfg.gogBinary?.trim() || "gog", env: process.env });

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
        { ok: Type.Boolean(), account: Type.Optional(Type.String()), recipients: Type.Optional(Type.Number()), transport: Type.Optional(Type.String()), degraded: Type.Optional(Type.Boolean()), attempts: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()) },
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
        const recipients = mail.to.length + mail.cc.length + mail.bcc.length;
        const result = await sendWithFallback(mail, fallbackConfigFromEnv(process.env), {
          sendViaGog,
          smtpSend: nodemailerSmtpSend,
          fetch,
        });
        const base = { account: mail.account, recipients, transport: result.transport, degraded: result.degraded, attempts: result.attempts };
        if (!result.ok) {
          return {
            content: [{ type: "text", text: `send_email failed from ${mail.account}: ${result.error}` }],
            details: { ok: false, ...base, error: result.error },
          };
        }
        const verb = mail.dryRun ? "validated (dry run, nothing sent)" : "sent";
        const warning = result.degraded
          ? ` WARNING: the main channel (gog) failed, so it went through the ${result.transport} fallback; the account's Google token probably needs attention (${result.attempts[0]?.detail ?? ""}).`
          : "";
        return {
          content: [{ type: "text", text: `Email ${verb} from ${mail.account} to ${recipients} recipient(s) via ${result.transport}.${warning}` }],
          details: { ok: true, ...base },
        };
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
