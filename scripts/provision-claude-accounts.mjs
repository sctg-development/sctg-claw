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
// IDEMPOTENT ON PURPOSE. Writing a profile's credentials issues a new "incarnation" of it, which
// changes its authorization identity, and every automation bound to that account then fails with
// "Automation inference account was replaced". So a profile is only (re)written when its token
// actually changed or the profile is missing. A truncated SHA-256 fingerprint of each token (never
// the token) is kept next to the OpenClaw state so the next start can tell.
//
// Env:
//   CLAUDE_CODE_OAUTH_TOKEN_<NAME>  one token per account (NAME = [A-Z0-9_]+)
//   CLAUDE_CODE_OAUTH_TOKEN         legacy single token, provisioned as `anthropic:default`
//   CLAUDE_ACCOUNT_ORDER            optional comma list of NAMEs, first = preferred
//   CLAUDE_TOKEN_EXPIRES_IN         optional, default "365d"
//   CLAUDE_ACCOUNTS_STATE           fingerprint file, default /home/node/.openclaw/claude-accounts.state.json
//   CLAUDE_FORCE_REPROVISION=1      rewrite every profile (this invalidates automations bound to them)
//   OPENCLAW_BIN                    optional, default "openclaw"
//
// Never blocks startup: every failure is a warning on stderr, exit code is 0.
// Tokens go to the CLI on stdin only, and are never logged.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PREFIX = "CLAUDE_CODE_OAUTH_TOKEN_";
// Not account tokens: the FD variant is what OpenClaw itself injects per run.
const NOT_AN_ACCOUNT = new Set(["FILE_DESCRIPTOR"]);
const NAME = /^[A-Z0-9][A-Z0-9_]*$/;

export function profileIdFor(name) {
  return `anthropic:${name.toLowerCase().replaceAll("_", "-")}`;
}

/** 64-bit fingerprint of a token. Enough to detect a change, useless to recover the token. */
export function fingerprint(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
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

// Pure: decide what to do for each account.
//   state:    { accounts: { [profileId]: fingerprint } } as saved by the previous start
//   existing: Set of profile ids the store currently has, or undefined when it could not be listed
// Returns { write: account[], keep: account[], adopted: profileId[] }.
export function planProvisioning(accounts, state, existing, { force = false } = {}) {
  const write = [];
  const keep = [];
  const adopted = [];
  for (const account of accounts) {
    const known = state.accounts?.[account.profileId];
    const present = existing === undefined ? known !== undefined : existing.has(account.profileId);
    if (force || !present) {
      write.push(account);
    } else if (known === undefined) {
      // The profile exists but no fingerprint was recorded (first start after this feature, or the
      // state file was lost). Rewriting would invalidate bound automations, so adopt it as is.
      adopted.push(account.profileId);
      keep.push(account);
    } else if (known !== fingerprint(account.token)) {
      write.push(account);
    } else {
      keep.push(account);
    }
  }
  return { write, keep, adopted };
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { accounts: parsed.accounts ?? {}, order: parsed.order ?? [] };
  } catch {
    return { accounts: {}, order: [] };
  }
}

function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function run(bin, args, input) {
  const result = spawnSync(bin, args, { input, encoding: "utf8", timeout: 60_000 });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    detail: (result.stderr || result.error?.message || "").trim(),
  };
}

function main() {
  const env = process.env;
  const bin = env.OPENCLAW_BIN || "openclaw";
  const expiresIn = env.CLAUDE_TOKEN_EXPIRES_IN || "365d";
  const stateFile = env.CLAUDE_ACCOUNTS_STATE || "/home/node/.openclaw/claude-accounts.state.json";
  const accounts = collectAccounts(env);
  if (accounts.length === 0) {
    return;
  }

  const state = readState(stateFile);
  const listing = run(bin, ["models", "auth", "list", "--provider", "anthropic"]);
  const listed = listing.ok ? accounts.map((a) => a.profileId).filter((id) => listing.stdout.includes(id)) : [];
  const haveFingerprints = accounts.some((a) => state.accounts[a.profileId] !== undefined);
  let existing;
  if (listing.ok && (listed.length > 0 || !haveFingerprints)) {
    existing = new Set(listed);
  } else if (!listing.ok) {
    console.error("provision-claude-accounts: could not list profiles, relying on the recorded fingerprints");
  } else {
    // Fingerprints exist but the listing shows none of those accounts: most likely the listing format
    // differs from what is searched for. Never guess "missing" here, that would rewrite (and so
    // invalidate) every bound account on each start.
    console.error("provision-claude-accounts: the profile listing shows none of the recorded accounts, relying on the recorded fingerprints");
  }
  const { write, keep, adopted } = planProvisioning(accounts, state, existing, {
    force: env.CLAUDE_FORCE_REPROVISION === "1",
  });

  const nextAccounts = {};
  for (const account of keep) {
    nextAccounts[account.profileId] = state.accounts[account.profileId] ?? fingerprint(account.token);
  }
  const written = [];
  for (const account of write) {
    const { ok, detail } = run(
      bin,
      ["models", "auth", "paste-token", "--provider", "anthropic", "--profile-id", account.profileId, "--expires-in", expiresIn],
      `${account.token}\n`,
    );
    if (ok) {
      written.push(account.profileId);
      nextAccounts[account.profileId] = fingerprint(account.token);
    } else {
      console.error(`provision-claude-accounts: could not store ${account.profileId}: ${detail.split("\n")[0]}`);
    }
  }

  const usable = accounts.map((a) => a.profileId).filter((id) => nextAccounts[id] !== undefined);
  // The order is only touched when it differs or an account was rewritten: a no-op start must not
  // write anything, so bound automations keep their authorization.
  const orderChanged = JSON.stringify(state.order) !== JSON.stringify(usable);
  if (usable.length > 1 && (orderChanged || written.length > 0)) {
    const { ok, detail } = run(bin, ["models", "auth", "order", "set", "--provider", "anthropic", ...usable]);
    if (!ok) {
      console.error(`provision-claude-accounts: could not set profile order: ${detail.split("\n")[0]}`);
    }
  }

  try {
    writeState(stateFile, { accounts: nextAccounts, order: usable });
  } catch (error) {
    console.error(`provision-claude-accounts: could not save the fingerprint file: ${error.message}`);
  }

  const parts = [];
  if (written.length) parts.push(`stored ${written.join(", ")}`);
  if (adopted.length) parts.push(`kept existing ${adopted.join(", ")} (no fingerprint recorded)`);
  const unchanged = keep.map((a) => a.profileId).filter((id) => !adopted.includes(id));
  if (unchanged.length) parts.push(`unchanged ${unchanged.join(", ")}`);
  if (parts.length) console.error(`provision-claude-accounts: ${parts.join("; ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
