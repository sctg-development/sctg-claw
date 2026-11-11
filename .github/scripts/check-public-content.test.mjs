import assert from "node:assert/strict";
import { test } from "node:test";
import { scanText } from "./check-public-content.mjs";

const rules = (text) => scanText(text, "f").map((x) => x.rule);

test("flags real-looking e-mails but not placeholders", () => {
  assert.deepEqual(rules("contact: someone@company.fr"), ["email"]);
  assert.deepEqual(rules("a@example.org b@x.org git@github.com:o/r.git noreply@anthropic.com"), []);
});

test("flags secret shapes without echoing the value", () => {
  const found = scanText("k=sk-ant-oat01-abcdefghijklmnop", "f");
  assert.equal(found[0].rule, "anthropic-token");
  assert.ok(!JSON.stringify(found).includes("abcdefghijklmnop"));
  assert.deepEqual(rules("AGE-SECRET-KEY-1ABCDEFGHIJKLMNOP"), ["age-secret-key"]);
  assert.deepEqual(rules("-----BEGIN OPENSSH PRIVATE KEY-----"), ["private-key-block"]);
  assert.deepEqual(rules("token ghp_abcdefghijklmnopqrstuvwx"), ["github-token"]);
});

test("flags private IPv4 only, not loopback, public, or version strings", () => {
  assert.deepEqual(rules("host 192.168.1.20 and 10.0.0.5 and 172.20.1.1"), ["private-ipv4", "private-ipv4", "private-ipv4"]);
  assert.deepEqual(rules("https://127.0.0.1:2379 and 8.8.8.8 and v1.6.3 and 172.15.0.1 and 172.32.0.1"), []);
});
