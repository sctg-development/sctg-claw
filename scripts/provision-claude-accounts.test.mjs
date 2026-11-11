import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectAccounts, profileIdFor } from "./provision-claude-accounts.mjs";

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

test("end to end: token only on stdin, never in argv; order set once with all profiles", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-prov-"));
  const log = path.join(dir, "calls.log");
  const fake = path.join(dir, "openclaw");
  writeFileSync(fake, `#!/bin/sh\nprintf 'ARGV:%s\\n' "$*" >> "${log}"\ncat >> "${log}"\n`);
  chmodSync(fake, 0o755);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "provision-claude-accounts.mjs");
  execFileSync("node", [script], {
    env: {
      PATH: process.env.PATH,
      OPENCLAW_BIN: fake,
      CLAUDE_CODE_OAUTH_TOKEN_CDVL59: "SECRET-A",
      CLAUDE_CODE_OAUTH_TOKEN_OFFICE_NOTARIAL_DIETSCH: "SECRET-B",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const calls = readFileSync(log, "utf8");
  const argvLines = calls.split("\n").filter((l) => l.startsWith("ARGV:"));
  assert.ok(argvLines.every((l) => !l.includes("SECRET")), "token leaked into argv");
  assert.match(calls, /SECRET-A/);
  assert.match(calls, /SECRET-B/);
  assert.equal(argvLines.filter((l) => l.includes("paste-token")).length, 2);
  assert.ok(argvLines.some((l) => l.includes("order set --provider anthropic anthropic:cdvl59 anthropic:office-notarial-dietsch")));
});
