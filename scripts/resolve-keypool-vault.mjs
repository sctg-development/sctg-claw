#!/usr/bin/env node
// Resolves provider credentials from a KeypoolLive vault (see
// git@github.com:sctg-development/ai-proxy-cloudflare.git and the sibling
// "cline" fork's apps/vscode/src/core/keypoollive/AiVault.ts, which this
// mirrors in Node-native crypto instead of WebCrypto) and prints
// `export FOO='...'` lines for the shell to eval before the gateway starts.
//
// Two kinds of exports:
//   * API-key pools: `<PROVIDER>_API_KEYS=k1,k2,...` from KEY_POOL_TARGETS.
//   * Claude Code OAuth tokens: one variable per vault entry of
//     `providers.anthropic`, named by the entry's `owner`
//     (e.g. owner `CLAUDE_CODE_OAUTH_TOKEN_CDVL59` ->
//     `export CLAUDE_CODE_OAUTH_TOKEN_CDVL59=...`). They are subscription
//     tokens, not API keys, so they never go into ANTHROPIC_API_KEYS.
//
// No-ops silently if KEYPOOL_VAULT_URL is unset; on any fetch/decrypt failure
// it warns on stderr and prints nothing on stdout, so `eval "$(...)"` is always
// safe and never blocks gateway startup. Key values are never logged: stderr
// only carries counts and variable names.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const PBKDF2_ITERATIONS = 100_000;
const FETCH_TIMEOUT_MS = 10_000;

// Vault section/name -> pool env var. LLM providers live under "providers",
// web-search/crawl tools under "crawlers" (keypoollive/types.ts: AiProtocol vs
// CrawlerProtocol). To pool another provider, add a line here AND make sure the
// consumer actually reads that variable (rotation is per-extension in the fork).
// Deliberately absent: `openai` (single "codex-proxy" credential, not a pool),
// `anthropic` (OAuth tokens, see CLAUDE_TOKEN_OWNER), and providers with no
// rotation-aware consumer (groq, morph, nvidia, sambanova, arcee).
export const KEY_POOL_TARGETS = [
  { section: "providers", name: "mistral", env: "MISTRAL_API_KEYS" },
  { section: "providers", name: "vibe", env: "VIBE_API_KEYS" },
  { section: "providers", name: "cohere", env: "COHERE_API_KEYS" },
  { section: "providers", name: "poolside", env: "POOLSIDE_API_KEYS" },
  { section: "providers", name: "openrouter", env: "OPENROUTER_API_KEYS" },
  { section: "providers", name: "elevenlabs", env: "ELEVENLABS_API_KEYS" },
  { section: "providers", name: "gemini", env: "GEMINI_API_KEYS" },
  { section: "crawlers", name: "firecrawl", env: "FIRECRAWL_API_KEYS" },
  { section: "crawlers", name: "exa", env: "EXA_API_KEYS" },
];

// An `anthropic` entry whose owner looks like this is exported under that exact
// name. Anything else in providers.anthropic is ignored (not an OAuth token).
export const CLAUDE_TOKEN_OWNER = /^CLAUDE_CODE_OAUTH_TOKEN_[A-Z0-9_]+$/;

// Best plan first, so rotation burns free keys last when mixed.
const TYPE_RANK = { unlimited: 0, premium: 1, paid: 2, free: 3 };

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fetchEncryptedVault(url, bearerToken) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!response.ok) {
    throw new Error(`vault fetch failed: HTTP ${response.status}`);
  }
  return response.text();
}

// OpenSSL `enc -aes-256-cbc -a -pbkdf2 -iter 100000 -salt` compatible:
// "Salted__" magic (8B) + salt (8B) + ciphertext, key+IV derived via
// PBKDF2-SHA256 into 48 bytes (32-byte key, 16-byte IV).
export function decryptVault(base64Ciphertext, password) {
  const raw = Buffer.from(base64Ciphertext.trim(), "base64");
  if (raw.subarray(0, 8).toString("utf8") !== "Salted__") {
    throw new Error("invalid vault format: missing 'Salted__' magic header");
  }
  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 48, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32, 48));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

// A key is usable unless it is flagged expired, empty, or known to be
// quota-exhausted until a future `quotaResetAt`.
function isUsable(entry, nowMs) {
  if (!entry || entry.type === "expired" || typeof entry.key !== "string" || !entry.key.trim()) {
    return false;
  }
  if (entry.quotaResetAt) {
    const resetMs = Date.parse(entry.quotaResetAt);
    if (Number.isFinite(resetMs) && resetMs > nowMs) {
      return false;
    }
  }
  return true;
}

function usableKeys(entries, nowMs) {
  return (entries ?? [])
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isUsable(entry, nowMs))
    .sort(
      (a, b) =>
        (TYPE_RANK[a.entry.type] ?? TYPE_RANK.free) - (TYPE_RANK[b.entry.type] ?? TYPE_RANK.free) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry.key.trim());
}

// Pure: decrypted vault -> { lines, summary, warnings }. `summary` holds only
// variable names and counts, safe to log.
export function buildExports(config, nowMs = Date.now()) {
  const lines = [];
  const summary = [];
  const warnings = [];

  for (const target of KEY_POOL_TARGETS) {
    const keys = usableKeys(config?.[target.section]?.[target.name]?.keys, nowMs);
    if (keys.length === 0) {
      continue;
    }
    lines.push(`export ${target.env}=${shellSingleQuote(keys.join(","))}`);
    summary.push(`${target.env}(${keys.length})`);
  }

  const seen = new Set();
  for (const entry of config?.providers?.anthropic?.keys ?? []) {
    const owner = typeof entry?.owner === "string" ? entry.owner.trim() : "";
    if (!CLAUDE_TOKEN_OWNER.test(owner)) {
      warnings.push("providers.anthropic has an entry whose owner is not CLAUDE_CODE_OAUTH_TOKEN_*, ignored");
      continue;
    }
    if (!isUsable(entry, nowMs)) {
      warnings.push(`${owner} is expired or exhausted in the vault, skipped`);
      continue;
    }
    if (seen.has(owner)) {
      warnings.push(`${owner} appears more than once in the vault, keeping the first`);
      continue;
    }
    seen.add(owner);
    lines.push(`export ${owner}=${shellSingleQuote(entry.key.trim())}`);
    summary.push(owner);
  }

  return { lines, summary, warnings };
}

async function main() {
  const vaultUrl = process.env.KEYPOOL_VAULT_URL;
  if (!vaultUrl) {
    return;
  }
  const secret = process.env.KEYPOOL_LIVE_SECRET;
  if (!secret) {
    console.error("resolve-keypool-vault: KEYPOOL_VAULT_URL is set but KEYPOOL_LIVE_SECRET is missing, skipping");
    return;
  }
  let config;
  try {
    const ciphertext = await fetchEncryptedVault(vaultUrl, secret);
    config = decryptVault(ciphertext, secret);
  } catch (error) {
    console.error(`resolve-keypool-vault: could not load vault, skipping: ${error.message}`);
    return;
  }
  const { lines, summary, warnings } = buildExports(config);
  for (const warning of warnings) {
    console.error(`resolve-keypool-vault: ${warning}`);
  }
  if (lines.length === 0) {
    console.error("resolve-keypool-vault: vault loaded but no matching provider/crawler keys found");
    return;
  }
  console.error(`resolve-keypool-vault: exported ${summary.join(", ")}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
