---
name: sctg-mail
description: Send email from the agent with the send_email tool (Gmail through gog). Use it for every outgoing email -- reports, alerts, newsletters -- instead of running `gog gmail send` yourself.
metadata: { "clawdbot": { "emoji": "✉️", "requires": { "bins": ["gog"] } } }
---

# Sending email

Use the **`send_email`** tool for every outgoing email. Do not build a `gog gmail send`
command line yourself: the tool handles quoting, recipient lists and temporary body files,
and it is restricted to sending (it cannot read or search the mailbox).

## Parameters

- `to` (required): one address, a comma-separated string, or an array. Bare addresses only
  (`name@example.org`, no `Name <...>`). Spaces after commas are fine.
- `subject` (required): a single line.
- `bodyHtml` and/or `bodyText`: at least one. Prefer `bodyHtml` for reports; the tool writes it
  to a temporary file for you, so there is no need for `/tmp/...html` and no cleanup step.
- `cc`, `bcc`: optional, same format as `to`.
- `account`: optional sender. Omit it to use the configured default. Only allow-listed accounts work.
- `dryRun`: validate and show what would be sent, without sending.

## Replacing the old shell recipe

Automations used to say "run `GOG_KEYRING_PASSWORD="" gog --account ... gmail send --to a, b ...
--body-html-file /tmp/x.html && rm /tmp/x.html`". Replace that step with one `send_email`
call. That recipe was fragile: spaces after commas in `--to` split the argument, and a typographic
dash (`—body-html-file`) is not a flag.

## Fallback channels

If gog fails (typically an expired Google token), the tool tries SMTP Gmail and then Cloudflare Email Sending, when
they are configured, and only for recipients on the operator's `ALERT_FALLBACK_RECIPIENTS` list. The result then has
`degraded: true` and a `transport` other than `gog`. Treat that as an incident: the message got through, but the
main channel is broken. Say so in your report instead of presenting it as a normal send. The message itself starts
with a notice saying that gog failed.

## When it fails

The result has `ok: false` and an `error`. If the error mentions an expired or revoked Google
token, the account must be re-authorized (`gog auth add`); retrying will not help. Report that
clearly instead of retrying in a loop, and do not try to send the same message from another
account unless the operator told you to.
