#!/usr/bin/env node
// Turns every `CLAUDE_CODE_OAUTH_TOKEN_<NAME>` environment variable (exported by
// scripts/resolve-keypool-vault.mjs from the vault's providers.anthropic entries)
// into a named OpenClaw auth profile `anthropic:<name>`, then sets the provider's
// profile order.
//
// Why profiles and not the env var: the Claude CLI backend deliberately CLEARS
// CLAUDE_CODE_OAUTH_TOKEN* from the environment it spawns `claude` with
// (extensions/anthropic/cli-constants.ts CLAUDE_CLI_CLEAR_ENV) and injects only
// the credential of the selected auth profile. Several profiles of the same
// provider are then rotated/failed over by OpenClaw itself (auth.order, with
// provider-reported cooldowns). Claude Team tokens come from `claude setup-token`
// and are valid for one year.
//
// Env:
//   CLAUDE_CODE_OAUTH_TOKEN_<NAME>  one token per account (NAME = [A-Z0-9_]+)
//   CLAUDE_CODE_OAUTH_TOKEN         legacy single token, provisioned as `anthropic:default`
//   CLAUDE_ACCOUNT_ORDER            optional comma list of NAMEs, first = preferred
//   CLAUDE_TOKEN_EXPIRES_IN         optional, default "365d"
//   OPENCLAW_BIN                    optional, default "openclaw"
//
// Never blocks startup: every failure is a warning on stderr, exit code is 0.
// Tokens go to the CLI on stdin only, and are never logged.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PREFIX = "CLAUDE_CODE_OAUTH_TOKEN_";
// Not account tokens: the FD variant is what OpenClaw itself injects per run.
const NOT_AN_ACCOUNT = new Set(["FILE_DESCRIPTOR"]);
const NAME = /^[A-Z0-9][A-Z0-9_]*$/;

export function profileIdFor(name) {
  return `anthropic:${name.toLowerCase().replaceAll("_", "-")}`;
}

// Pure: env -> [{ name, profileId, token }] in the order they should be tried.
export function collectAccounts(env) {
  const accounts = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || typeof value !== "string" || !value.trim()) {
      continue;
    }
    const name = key.slice(PREFIX.length);
    if (NOT_AN_ACCOUNT.has(name) || !NAME.test(name)) {
      continue;
    }
    accounts.push({ name, profileId: profileIdFor(name), token: value.trim() });
  }
  const legacy = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (legacy && !accounts.some((a) => a.token === legacy)) {
    accounts.push({ name: "DEFAULT", profileId: "anthropic:default", token: legacy });
  }
  const preferred = (env.CLAUDE_ACCOUNT_ORDER ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const rank = (a) => {
    const i = preferred.indexOf(a.name);
    return i === -1 ? preferred.length : i;
  };
  return accounts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function run(bin, args, input) {
  const result = spawnSync(bin, args, { input, encoding: "utf8", timeout: 60_000 });
  return { ok: result.status === 0, detail: (result.stderr || result.error?.message || "").trim() };
}

function main() {
  const env = process.env;
  const bin = env.OPENCLAW_BIN || "openclaw";
  const expiresIn = env.CLAUDE_TOKEN_EXPIRES_IN || "365d";
  const accounts = collectAccounts(env);
  if (accounts.length === 0) {
    return;
  }
  const stored = [];
  for (const account of accounts) {
    const { ok, detail } = run(
      bin,
      ["models", "auth", "paste-token", "--provider", "anthropic", "--profile-id", account.profileId, "--expires-in", expiresIn],
      `${account.token}\n`,
    );
    if (ok) {
      stored.push(account.profileId);
    } else {
      console.error(`provision-claude-accounts: could not store ${account.profileId}: ${detail.split("\n")[0]}`);
    }
  }
  if (stored.length === 0) {
    return;
  }
  // A single profile needs no order; with several, pin the explicit priority so
  // failover is deterministic (preferred first, others on rate limit).
  if (stored.length > 1) {
    const { ok, detail } = run(bin, ["models", "auth", "order", "set", "--provider", "anthropic", ...stored]);
    if (!ok) {
      console.error(`provision-claude-accounts: could not set profile order: ${detail.split("\n")[0]}`);
    }
  }
  console.error(`provision-claude-accounts: stored ${stored.join(", ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
