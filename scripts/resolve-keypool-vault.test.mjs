import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { buildExports, decryptVault } from "./resolve-keypool-vault.mjs";

const NOW = Date.parse("2026-11-11T12:00:00Z");

test("decryptVault round-trips an openssl-style Salted__ payload", () => {
  const password = "s3cret";
  const salt = crypto.randomBytes(8);
  const d = crypto.pbkdf2Sync(password, salt, 100_000, 48, "sha256");
  const cipher = crypto.createCipheriv("aes-256-cbc", d.subarray(0, 32), d.subarray(32));
  const body = Buffer.concat([cipher.update(JSON.stringify({ ok: 1 })), cipher.final()]);
  const b64 = Buffer.concat([Buffer.from("Salted__"), salt, body]).toString("base64");
  assert.deepEqual(decryptVault(b64, password), { ok: 1 });
  assert.throws(() => decryptVault(Buffer.from("nope").toString("base64"), password), /Salted__/);
});

test("pools skip expired/exhausted keys and rank paid before free", () => {
  const { lines } = buildExports(
    {
      providers: {
        mistral: {
          keys: [
            { key: "free1", type: "free" },
            { key: "dead", type: "expired" },
            { key: "later", quotaResetAt: "2026-11-12T00:00:00Z" },
            { key: "back", quotaResetAt: "2026-11-10T00:00:00Z", type: "free" },
            { key: "pay", type: "paid" },
          ],
        },
      },
    },
    NOW,
  );
  assert.deepEqual(lines, ["export MISTRAL_API_KEYS='pay,free1,back'"]);
});

test("claude oauth tokens are exported by owner name, never pooled", () => {
  const { lines, warnings } = buildExports({
    providers: {
      anthropic: {
        keys: [
          { key: "tok-a", owner: "CLAUDE_CODE_OAUTH_TOKEN_CDVL59" },
          { key: "tok-b", owner: "CLAUDE_CODE_OAUTH_TOKEN_OFFICE_NOTARIAL_DIETSCH" },
          { key: "api", owner: "someone@example.org" },
          { key: "x; rm -rf /", owner: "CLAUDE_CODE_OAUTH_TOKEN_a b" },
        ],
      },
    },
  });
  assert.deepEqual(lines, [
    "export CLAUDE_CODE_OAUTH_TOKEN_CDVL59='tok-a'",
    "export CLAUDE_CODE_OAUTH_TOKEN_OFFICE_NOTARIAL_DIETSCH='tok-b'",
  ]);
  assert.equal(warnings.length, 2);
  assert.ok(!lines.some((l) => l.includes("ANTHROPIC_API_KEYS")));
});

test("single quotes in values cannot break out of the shell quoting", () => {
  const { lines } = buildExports({ crawlers: { exa: { keys: [{ key: "a'b" }] } } });
  assert.equal(lines[0], "export EXA_API_KEYS='a'\\''b'");
});
