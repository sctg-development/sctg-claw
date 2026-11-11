import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGogArgs, explainGogFailure, normalizeAddresses, validateMail } from "./mail.ts";

const config = { defaultAccount: "sender@example.org", maxRecipients: 3 };
const ok = { to: ["a@example.org"], subject: "Hi", bodyText: "x" };

test("normalizeAddresses tolerates the comma+space form that breaks the shell", () => {
  assert.deepEqual(normalizeAddresses("a@x.org, b@y.org,c@z.org"), ["a@x.org", "b@y.org", "c@z.org"]);
  assert.deepEqual(normalizeAddresses(["a@x.org, b@y.org"]), ["a@x.org", "b@y.org"]);
});

test("rejects missing/unlisted accounts, bad addresses, header injection, empty body", () => {
  assert.match(String((validateMail(ok, {}) as any).error), /no sender account/);
  assert.match(String((validateMail({ ...ok, account: "evil@x.org" }, config) as any).error), /allowedAccounts/);
  assert.match(String((validateMail({ ...ok, to: ["a@x.org --foo"] }, config) as any).error), /invalid recipient/);
  assert.match(String((validateMail({ ...ok, to: ["Bob <b@x.org>"] }, config) as any).error), /invalid recipient/);
  assert.match(String((validateMail({ ...ok, subject: "a\nBcc: z@x.org" }, config) as any).error), /single line/);
  assert.match(String((validateMail({ ...ok, bodyText: " " }, config) as any).error), /bodyHtml or bodyText/);
  assert.match(String((validateMail({ ...ok, to: ["a@x.org", "b@x.org", "c@x.org", "d@x.org"] }, config) as any).error), /too many/);
});

test("account matching is case-insensitive and allowedAccounts widens the default", () => {
  const cfg = { defaultAccount: "a@x.org", allowedAccounts: ["a@x.org", "B@x.org"] };
  assert.equal(validateMail({ ...ok, account: "b@X.org" }, cfg).ok, true);
});

test("gog args: send-only, no-input, comma-joined recipients, bodies as files", () => {
  const v = validateMail({ to: "a@x.org, b@y.org", cc: ["c@x.org"], subject: "S", bodyHtml: "<p>x</p>" }, config);
  assert.ok(v.ok);
  const args = buildGogArgs(v.mail, { htmlFile: "/tmp/b.html" });
  assert.deepEqual(args.slice(0, 5), ["--account", "sender@example.org", "--enable-commands-exact", "gmail.send", "--no-input"]);
  assert.equal(args[args.indexOf("--to") + 1], "a@x.org,b@y.org");
  assert.equal(args[args.indexOf("--cc") + 1], "c@x.org");
  assert.equal(args[args.indexOf("--body-html-file") + 1], "/tmp/b.html");
  assert.ok(!args.includes("--dry-run"));
});

test("dryRun is forwarded", () => {
  const v = validateMail({ ...ok, dryRun: true }, config);
  assert.ok(v.ok);
  assert.ok(buildGogArgs(v.mail, { textFile: "/tmp/t" }).includes("--dry-run"));
});

test("token failures get an actionable explanation", () => {
  assert.match(explainGogFailure("oauth2: \"invalid_grant\" \"Token has been expired or revoked.\""), /In production/);
  assert.equal(explainGogFailure("boom\nsecond"), "boom | second");
});
