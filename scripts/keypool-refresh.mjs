#!/usr/bin/env node
// Long-running cirond program: re-reads the KeypoolLive vault periodically and,
// when the credentials really changed, re-provisions Claude accounts and
// restarts the gateway so it picks up the new environment.
//
// Honest scope: OpenClaw reads provider keys from its process environment at
// startup, so "refresh" means a gateway restart, not an in-place swap. To keep
// that rare it only happens when a value differs from what the gateway runs
// with, and at most once per KEYPOOL_MIN_RESTART_SECONDS.
//
// How the new values reach the gateway: this script writes them to a 0600 env
// file (default /tmp/keypool/env, NOT the persistence volume, so secrets are not
// persisted) which the gateway's cirond command sources before `exec node ...`
// (see scripts/ciron.toml). Only additions/changes are applied: a pool that the
// vault empties entirely keeps its previous value until the pod restarts.
//
// Env:
//   KEYPOOL_VAULT_URL / KEYPOOL_LIVE_SECRET   same as resolve-keypool-vault.mjs
//   KEYPOOL_REFRESH_SECONDS       poll period, default 900; 0 disables (exit 0)
//   KEYPOOL_MIN_RESTART_SECONDS   minimum gap between restarts, default 600
//   KEYPOOL_ENV_FILE              default /tmp/keypool/env
//   CIRON_SOCKET                  default unix:///tmp/cirond.sock
//   GATEWAY_PROGRAM               cirond program to restart, default openclaw-gateway
// Logs only variable names and counts, never values.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildExports, decryptVault, fetchEncryptedVault, shellSingleQuote } from "./resolve-keypool-vault.mjs";

// Pure: names whose desired value differs from what is currently applied.
export function changedVars(applied, desired) {
  return Object.keys(desired)
    .filter((name) => applied[name] !== desired[name])
    .sort();
}

// Pure: contents of the env file the gateway sources.
export function renderEnvFile(vars) {
  return `${Object.entries(vars)
    .map(([name, value]) => `export ${name}=${shellSingleQuote(value)}`)
    .join("\n")}\n`;
}

// Pure: restart gate.
export function mayRestart(nowMs, lastRestartMs, minGapMs) {
  return lastRestartMs === undefined || nowMs - lastRestartMs >= minGapMs;
}

function writeEnvFileAtomically(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function log(message) {
  console.error(`keypool-refresh: ${message}`);
}

async function cycle(state, config) {
  let desired;
  try {
    const ciphertext = await fetchEncryptedVault(config.vaultUrl, config.secret);
    desired = buildExports(decryptVault(ciphertext, config.secret)).vars;
  } catch (error) {
    log(`could not load vault, keeping current credentials: ${error.message}`);
    return;
  }
  const changed = changedVars(state.applied, desired);
  if (changed.length === 0) {
    return;
  }
  if (!mayRestart(Date.now(), state.lastRestartMs, config.minGapMs)) {
    log(`${changed.length} change(s) pending (${changed.join(", ")}), restart deferred by rate limit`);
    return;
  }
  // Only vault-derived variables go to disk, never the whole process environment.
  writeEnvFileAtomically(config.envFile, renderEnvFile({ ...state.written, ...desired }));
  // Claude accounts live in OpenClaw auth profiles, not env: re-provision with the new values.
  const provisioner = path.join(path.dirname(fileURLToPath(import.meta.url)), "provision-claude-accounts.mjs");
  spawnSync("node", [provisioner], { env: { ...process.env, ...desired }, stdio: ["ignore", "ignore", "inherit"] });
  const restart = spawnSync("cironctl", ["-t", config.socket, "restart", config.program], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (restart.status !== 0) {
    log(`restart of ${config.program} failed (${(restart.stderr || restart.error?.message || "").trim().split("\n")[0]}), will retry next cycle`);
    return;
  }
  Object.assign(state.applied, desired);
  Object.assign(state.written, desired);
  state.lastRestartMs = Date.now();
  log(`applied ${changed.join(", ")} and restarted ${config.program}`);
}

async function main() {
  const env = process.env;
  const refreshSeconds = Number(env.KEYPOOL_REFRESH_SECONDS ?? 900);
  if (!env.KEYPOOL_VAULT_URL || !env.KEYPOOL_LIVE_SECRET || !(refreshSeconds > 0)) {
    return; // disabled: exit 0 so cirond's restart="on-failure" leaves it stopped
  }
  const config = {
    vaultUrl: env.KEYPOOL_VAULT_URL,
    secret: env.KEYPOOL_LIVE_SECRET,
    minGapMs: Number(env.KEYPOOL_MIN_RESTART_SECONDS ?? 600) * 1000,
    envFile: env.KEYPOOL_ENV_FILE || "/tmp/keypool/env",
    socket: env.CIRON_SOCKET || "unix:///tmp/cirond.sock",
    program: env.GATEWAY_PROGRAM || "openclaw-gateway",
  };
  // Baseline = what the gateway was started with (this process inherits the same env),
  // so a vault change between pod boot and the first poll is not swallowed.
  const state = { applied: { ...env }, written: {}, lastRestartMs: undefined };
  log(`watching the vault every ${refreshSeconds}s`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, refreshSeconds * 1000));
    try {
      await cycle(state, config);
    } catch (error) {
      log(`unexpected error: ${error.message}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
