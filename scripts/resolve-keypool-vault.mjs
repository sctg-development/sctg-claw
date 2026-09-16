#!/usr/bin/env node
// Resolves provider API keys from a KeypoolLive vault (see
// git@github.com:sctg-development/ai-proxy-cloudflare.git and the sibling
// "cline" fork's apps/vscode/src/core/keypoollive/AiVault.ts, which this
// mirrors in Node-native crypto instead of WebCrypto) and prints
// `export FOO_API_KEYS='...'` lines for the shell to eval before the gateway
// starts. No-ops silently if KEYPOOL_VAULT_URL is unset; on any fetch/decrypt
// failure it warns on stderr and prints nothing on stdout, so `eval "$(...)"`
// is always safe and never blocks gateway startup.
import crypto from "node:crypto";

const PBKDF2_ITERATIONS = 100_000;
const FETCH_TIMEOUT_MS = 10_000;

// Vault section -> openclaw pool env var. LLM chat providers live under
// "providers"; web-search/crawl tools live under "crawlers" (see
// keypoollive/types.ts: AiProtocol vs CrawlerProtocol).
const KEY_POOL_TARGETS = [
  { section: "providers", name: "mistral", env: "MISTRAL_API_KEYS" },
  { section: "providers", name: "cohere", env: "COHERE_API_KEYS" },
  { section: "providers", name: "poolside", env: "POOLSIDE_API_KEYS" },
  { section: "crawlers", name: "firecrawl", env: "FIRECRAWL_API_KEYS" },
  { section: "crawlers", name: "exa", env: "EXA_API_KEYS" },
];

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
function decryptVault(base64Ciphertext, password) {
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

function usableKeys(entries) {
  return (entries ?? []).filter((entry) => entry.type !== "expired").map((entry) => entry.key);
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
  const lines = [];
  for (const target of KEY_POOL_TARGETS) {
    const entry = config[target.section]?.[target.name];
    const keys = usableKeys(entry?.keys);
    if (keys.length === 0) {
      continue;
    }
    lines.push(`export ${target.env}=${shellSingleQuote(keys.join(","))}`);
  }
  if (lines.length === 0) {
    console.error("resolve-keypool-vault: vault loaded but no matching provider/crawler keys found");
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

await main();
