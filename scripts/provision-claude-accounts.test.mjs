import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectAccounts, fingerprint, planProvisioning, profileIdFor } from "./provision-claude-accounts.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "provision-claude-accounts.mjs");

test("profile ids are lowercase and dash-separated", () => {
  assert.equal(profileIdFor("OFFICE_NOTARIAL_DIETSCH"), "anthropic:office-notarial-dietsch");
});

test("collects named tokens, skips FD variant and junk, honours preferred order", () => {
  const accounts = collectAccounts({
    CLAUDE_CODE_OAUTH_TOKEN_CDVL59: "a",
    CLAUDE_CODE_OAUTH_TOKEN_OFFICE_NOTARIAL_DIETSCH: "b",
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
    CLAUDE_CODE_OAUTH_TOKEN_EMPTY: "  ",
    CLAUDE_CODE_OAUTH_TOKEN_bad: "x",
    CLAUDE_ACCOUNT_ORDER: "office_notarial_dietsch",
  });
  assert.deepEqual(accounts.map((a) => a.name), ["OFFICE_NOTARIAL_DIETSCH", "CDVL59"]);
});

test("legacy single token becomes anthropic:default unless already covered", () => {
  assert.deepEqual(collectAccounts({ CLAUDE_CODE_OAUTH_TOKEN: "t" }).map((a) => a.profileId), ["anthropic:default"]);
  assert.equal(collectAccounts({ CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN_X1: "t" }).length, 1);
});

test("fingerprint is stable, short, and does not contain the token", () => {
  const fp = fingerprint("fake-token-one");
  assert.equal(fp, fingerprint("fake-token-one"));
  assert.equal(fp.length, 16);
  assert.ok(!"fake-token-one".includes(fp));
  assert.notEqual(fp, fingerprint("fake-token-two"));
});

const acct = (name, token) => ({ name, profileId: profileIdFor(name), token });

test("plan: unchanged token and present profile are kept, not rewritten", () => {
  const a = acct("A", "tok-a");
  const plan = planProvisioning([a], { accounts: { [a.profileId]: fingerprint("tok-a") } }, new Set([a.profileId]));
  assert.deepEqual([plan.write.length, plan.keep.length, plan.adopted.length], [0, 1, 0]);
});

test("plan: a changed token, a missing profile, or force each rewrite", () => {
  const a = acct("A", "tok-a");
  const st = { accounts: { [a.profileId]: fingerprint("old") } };
  assert.equal(planProvisioning([a], st, new Set([a.profileId])).write.length, 1, "token changed");
  const same = { accounts: { [a.profileId]: fingerprint("tok-a") } };
  assert.equal(planProvisioning([a], same, new Set()).write.length, 1, "profile missing");
  assert.equal(planProvisioning([a], same, new Set([a.profileId]), { force: true }).write.length, 1, "forced");
});

test("plan: an existing profile with no recorded fingerprint is adopted, never rewritten", () => {
  const a = acct("A", "tok-a");
  const plan = planProvisioning([a], { accounts: {} }, new Set([a.profileId]));
  assert.deepEqual([plan.write.length, plan.adopted], [0, [a.profileId]]);
});

test("plan: when the store cannot be listed, the fingerprints decide", () => {
  const a = acct("A", "tok-a");
  assert.equal(planProvisioning([a], { accounts: { [a.profileId]: fingerprint("tok-a") } }, undefined).write.length, 0);
  assert.equal(planProvisioning([a], { accounts: {} }, undefined).write.length, 1);
});

// --- end to end with a fake `openclaw` -------------------------------------------------------------
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-prov-"));
  const log = path.join(dir, "calls.log");
  const listFile = path.join(dir, "list.txt");
  const fake = path.join(dir, "openclaw");
  writeFileSync(listFile, "");
  writeFileSync(
    fake,
    `#!/bin/sh
echo "ARGV:$*" >> "${log}"
case "$*" in
  *"auth list"*) [ "$FAKE_LIST_FAIL" = 1 ] && exit 1; cat "${listFile}"; exit 0;;
  *paste-token*) cat >> "${log}";;
esac
exit 0
`,
  );
  chmodSync(fake, 0o755);
  const base = { PATH: process.env.PATH, OPENCLAW_BIN: fake, CLAUDE_ACCOUNTS_STATE: path.join(dir, "state.json") };
  return {
    dir,
    setList(ids) {
      writeFileSync(listFile, ids.join("\n"));
    },
    run(extraEnv) {
      writeFileSync(log, "");
      const r = spawnSync("node", [script], { env: { ...base, ...extraEnv }, encoding: "utf8" });
      const calls = readFileSync(log, "utf8");
      const argv = calls.split("\n").filter((l) => l.startsWith("ARGV:"));
      return {
        calls,
        argv,
        pastes: argv.filter((l) => l.includes("paste-token")),
        orders: argv.filter((l) => l.includes("order set")),
        stderr: r.stderr,
        status: r.status,
      };
    },
    state: () => JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")),
  };
}

const TOKENS = { CLAUDE_CODE_OAUTH_TOKEN_CDVL59: "SECRET-A", CLAUDE_CODE_OAUTH_TOKEN_OFFICE_NOTARIAL_DIETSCH: "SECRET-B" };
const IDS = ["anthropic:cdvl59", "anthropic:office-notarial-dietsch"];

test("first start: stores both accounts (token on stdin only), sets the order, records fingerprints", () => {
  const h = harness();
  const r = h.run(TOKENS);
  assert.equal(r.pastes.length, 2);
  assert.ok(r.argv.every((l) => !l.includes("SECRET")), "token leaked into argv");
  assert.match(r.calls, /SECRET-A/);
  assert.ok(r.orders[0].includes(`order set --provider anthropic ${IDS.join(" ")}`));
  assert.deepEqual(Object.keys(h.state().accounts).sort(), IDS);
  assert.ok(!JSON.stringify(h.state()).includes("SECRET"), "state file must not hold tokens");
});

test("second start with the same tokens writes NOTHING (keeps bound automations valid)", () => {
  const h = harness();
  h.run(TOKENS);
  h.setList(IDS);
  const r = h.run(TOKENS);
  assert.equal(r.pastes.length, 0, "must not rewrite unchanged accounts");
  assert.equal(r.orders.length, 0, "must not rewrite an unchanged order");
  assert.match(r.stderr, /unchanged anthropic:cdvl59/);
});

test("a rotated token rewrites only that account and re-sets the order", () => {
  const h = harness();
  h.run(TOKENS);
  h.setList(IDS);
  const r = h.run({ ...TOKENS, CLAUDE_CODE_OAUTH_TOKEN_CDVL59: "SECRET-A2" });
  assert.equal(r.pastes.length, 1);
  assert.ok(r.pastes[0].includes("anthropic:cdvl59"));
  assert.equal(r.orders.length, 1);
});

test("first start after upgrade (profiles exist, no state): adopts them without rewriting", () => {
  const h = harness();
  h.setList(IDS);
  const r = h.run(TOKENS);
  assert.equal(r.pastes.length, 0);
  assert.match(r.stderr, /kept existing/);
  assert.deepEqual(Object.keys(h.state().accounts).sort(), IDS);
});

test("a profile deleted from the store is restored; an unlistable store falls back to fingerprints", () => {
  const h = harness();
  h.run(TOKENS);
  h.setList(["anthropic:cdvl59"]);
  const r = h.run(TOKENS);
  assert.equal(r.pastes.length, 1);
  assert.ok(r.pastes[0].includes("office-notarial-dietsch"));
  const r2 = h.run({ ...TOKENS, FAKE_LIST_FAIL: "1" });
  assert.equal(r2.pastes.length, 0, "fingerprints match, listing unavailable: do not rewrite");
});

test("a listing in an unexpected format never triggers a rewrite when fingerprints match", () => {
  const h = harness();
  h.run(TOKENS);
  h.setList(["some unrelated output", "with no profile ids"]);
  const r = h.run(TOKENS);
  assert.equal(r.pastes.length, 0);
  assert.match(r.stderr, /relying on the recorded fingerprints/);
});

test("CLAUDE_FORCE_REPROVISION=1 rewrites everything", () => {
  const h = harness();
  h.run(TOKENS);
  h.setList(IDS);
  assert.equal(h.run({ ...TOKENS, CLAUDE_FORCE_REPROVISION: "1" }).pastes.length, 2);
});
