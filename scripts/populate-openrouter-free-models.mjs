#!/usr/bin/env node
// Populates OpenRouter's free model catalog (ids ending in ":free") into
// <state-dir>/openclaw.json (~/.openclaw/openclaw.json), under
// models.providers.openrouter.models. Standalone and independent of the
// openclaw package itself -- only Node builtins, no repo imports -- so it can
// be copied into the runtime image and invoked from the container CMD, the
// same way scripts/resolve-keypool-vault.mjs seeds provider key pools.
//
// Each written row is tagged `metadataSource: "models-add"` (an OpenClaw
// config field already reserved for CLI/catalog-added entries; see
// ModelDefinitionConfig in openclaw/src/config/types.models.ts). On every run
// this script only replaces rows carrying that tag and leaves every other
// entry (bundled catalog, or anything hand-declared via Helm values / the
// openclaw-config ConfigMap) untouched, so it is safe to re-run on every
// container start without clobbering manually curated models.
//
// Discovered free models are also synced into
// agents.defaults.modelPolicy.allow (as "openrouter/<catalog-id>" refs, the
// exact key OpenClaw's model-selection matcher expects), but ONLY when that
// allow list already exists and is non-empty: an absent/empty allow means
// "any model allowed" in OpenClaw, so creating one here would newly
// *restrict* access instead of only adding to it. When it does exist, this
// script only replaces the "openrouter/*:free" entries it previously added
// and leaves every other allow entry untouched.
//
// No-ops silently if OPENROUTER_API_KEYS/OPENROUTER_API_KEY is unset, and
// warns on stderr (without throwing) on any fetch/parse/write failure, so
// invoking this from a container CMD chain never blocks gateway startup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Base URL for the OpenRouter models API. Can be overridden via OPENROUTER_BASE_URL env var. */
const OPENROUTER_MODELS_URL = `${process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1"}/models`;
/** Maximum time (ms) to wait for a single OpenRouter API response before aborting. */
const FETCH_TIMEOUT_MS = 10_000;
/** Regex used to split a delimited string of API keys into individual entries. */
const KEY_SPLIT_RE = /[\s,;]+/g;
/** Tag value written to each model row's `metadataSource` field so we can identify
 *  and replace only the entries we previously added on subsequent runs. */
const METADATA_SOURCE = "models-add";
/** Suffix that OpenRouter appends to free-tier model ids (e.g. `openai/gpt-4.1:free`). */
const FREE_SUFFIX = ":free";
/** Modalities from the OpenRouter architecture spec that OpenClaw recognises and supports in its config. */
const ALLOWED_INPUT_MODALITIES = ["text", "image", "video", "audio"];
/** Regex matching the allow-list ref format for free models (e.g. `openrouter/openai/gpt-4.1:free`). */
const OPENROUTER_FREE_ALLOW_REF_RE = /^openrouter\/.+:free$/;

/**
 * Splits a raw environment-variable string into an array of trimmed, non-empty API keys.
 * Accepts whitespace, comma, or semicolon as delimiters between keys.
 *
 * @param {string|undefined} raw - The raw value from an environment variable (may be undefined).
 * @returns {string[]} An array of individual key strings with surrounding whitespace removed.
 */
function parseKeyList(raw) {
  // Return an empty array early if the env var was never set, avoiding unnecessary processing.
  if (!raw) {
    return [];
  }
  // Split on any combination of whitespace, commas, or semicolons, then trim each piece
  // and discard empty strings that result from adjacent delimiters.
  return raw
    .split(KEY_SPLIT_RE)
    .map((key) => key.trim())
    .filter(Boolean);
}

/**
 * Resolves the list of candidate OpenRouter API keys from environment variables.
 *
 * Looks at both `OPENROUTER_API_KEYS` (plural, multi-key, delimited) and
 * `OPENROUTER_API_KEY` (singular, single key). Deduplicates while preserving
 * the order in which keys first appear, so the first key is tried first during
 * the fetch loop.
 *
 * @returns {string[]} An array of unique API keys. Returns an empty array if no keys are set.
 */
function resolveCandidateApiKeys() {
  // Use a Set to deduplicate keys that might appear in both env vars or be listed twice.
  const seen = new Set();
  // Spread both parsed lists into a single iteration order: plural env var first, then singular.
  for (const key of [
    ...parseKeyList(process.env.OPENROUTER_API_KEYS),
    ...parseKeyList(process.env.OPENROUTER_API_KEY),
  ]) {
    seen.add(key);
  }
  // Convert back to an array for ordered iteration.
  return [...seen];
}

/**
 * Fetches the OpenRouter models catalog by trying each API key in sequence.
 *
 * The function iterates over the provided keys and returns as soon as one
 * succeeds. If a key receives a non-OK HTTP response or the response body
 * doesn't match the expected `{ data: [...] }` shape, it records the error
 * and tries the next key. This makes the fetch resilient to stale or revoked
 * keys in multi-key configurations.
 *
 * @param {string[]} apiKeys - Ordered list of candidate API keys to try.
 * @returns {Promise<object[]>} The `data` array from the OpenRouter `/models` response.
 * @throws {Error} If all keys fail, the last error is thrown. If the key list is empty,
 *   throws "no OpenRouter API key available".
 */
async function fetchOpenRouterModels(apiKeys) {
  let lastError;
  // Try each key in order; return immediately on the first success.
  for (const apiKey of apiKeys) {
    try {
      // Abort the request if it takes longer than FETCH_TIMEOUT_MS.
      const response = await fetch(OPENROUTER_MODELS_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // OpenRouter uses Bearer token auth.
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      // Non-2xx responses mean this key is likely invalid or rate-limited; record and try the next.
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        continue;
      }
      const payload = await response.json();
      // The OpenRouter /models endpoint returns { data: [...model entries...] }.
      if (!Array.isArray(payload?.data)) {
        lastError = new Error("unexpected response shape: missing data[] array");
        continue;
      }
      return payload.data;
    } catch (error) {
      // Captures network errors, timeouts, and JSON parse failures.
      lastError = error;
    }
  }
  // If we exhausted all keys without success, throw the last recorded error.
  // The ?? fallback covers the edge case where apiKeys was empty.
  throw lastError ?? new Error("no OpenRouter API key available");
}

/**
 * Reads a numeric field from an OpenRouter catalog item, returning `undefined`
 * if the value is missing or not a finite number.
 *
 * @param {object} item - An OpenRouter model catalog entry.
 * @param {string} field - The field name to read.
 * @returns {number|undefined} The numeric value, or `undefined` if absent/invalid.
 */
function numberField(item, field) {
  const value = item?.[field];
  // Guard against NaN, Infinity, and non-number types from malformed API responses.
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads an array-of-strings field from an OpenRouter catalog item, returning
 * a clean string array (non-string entries filtered out). Returns an empty
 * array if the field is absent or not an array.
 *
 * @param {object} item - An OpenRouter model catalog entry.
 * @param {string} field - The field name to read.
 * @returns {string[]} The filtered array of string values, or `[]` if absent/invalid.
 */
function stringArrayField(item, field) {
  const value = item?.[field];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * Tests whether a model id is a free-tier OpenRouter model (ends with ":free").
 *
 * @param {string} id - The OpenRouter model id to test.
 * @returns {boolean} `true` if the id ends with `:free`, `false` otherwise.
 */
function isFreeOpenRouterModelId(id) {
  // OpenRouter tags free-tier models with a ":free" suffix on the model id.
  return typeof id === "string" && id.endsWith(FREE_SUFFIX);
}

/**
 * Maps one OpenRouter catalog entry into an OpenClaw ModelDefinitionConfig row.
 *
 * Reads display name, reasoning support, input modalities, context window, and
 * max output tokens from the catalog entry, falling back to sensible defaults
 * when fields are missing. The resulting row is tagged with `metadataSource:
 * "models-add"` so it can be identified and replaced on subsequent runs.
 *
 * @param {object} item - A single entry from the OpenRouter `/models` `data` array.
 * @returns {object} A ModelDefinitionConfig-compatible object for OpenClaw.
 */
function toModelDefinitionConfig(item) {
  // The model id is the full OpenRouter id (e.g. "openai/gpt-4.1:free").
  const id = item.id;
  // top_provider holds provider-specific limits (context_length, max_completion_tokens).
  const topProvider = item.top_provider ?? {};
  // architecture describes model capabilities (input_modalities, etc.).
  const architecture = item.architecture ?? {};
  // supported_parameters lists features like "reasoning" (chain-of-thought) if available.
  const supportedParameters = stringArrayField(item, "supported_parameters");

  // Build the input modalities list, lowercasing and filtering to only supported values.
  const inputModalities = stringArrayField(architecture, "input_modalities")
    .map((entry) => entry.toLowerCase())
    .filter((entry) => ALLOWED_INPUT_MODALITIES.includes(entry));

  // Context window: prefer the provider-specific value, fall back to the top-level one.
  const contextWindow = numberField(topProvider, "context_length") ?? numberField(item, "context_length");
  // Max output tokens: prefer provider-specific, then top-level, then context window, then 4096 default.
  const maxTokens =
    numberField(topProvider, "max_completion_tokens") ??
    numberField(item, "max_completion_tokens") ??
    contextWindow ??
    4096;

  return {
    id,
    // Use the catalog name if available and non-empty, otherwise fall back to the id.
    name: typeof item.name === "string" && item.name.trim() ? item.name : id,
    // Free models may or may not support reasoning; reflect what the API declares.
    reasoning: supportedParameters.includes("reasoning"),
    // Default to ["text"] if no recognised modalities were found.
    input: inputModalities.length > 0 ? inputModalities : ["text"],
    // Free-tier models have zero cost across all token types.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Only include contextWindow if we actually resolved a numeric value.
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    maxTokens,
    // Tag this entry so the script can cleanly replace it on the next run.
    metadataSource: METADATA_SOURCE,
  };
}

/**
 * Resolves the user's home directory using a priority chain of env vars:
 * `OPENCLAW_HOME` > `HOME` > `USERPROFILE` > `os.homedir()`.
 *
 * @returns {string} The resolved home directory path.
 */
function resolveHomeDir() {
  // OPENCLAW_HOME takes precedence, useful in containers where HOME might not be set.
  // USERPROFILE is checked as a Windows fallback before os.homedir().
  return (
    process.env.OPENCLAW_HOME?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    os.homedir()
  );
}

/**
 * Resolves the path to the OpenClaw state file (`openclaw.json`).
 *
 * Uses `OPENCLAW_STATE_DIR` if set, otherwise defaults to `~/.openclaw`.
 *
 * @returns {string} The absolute path to `openclaw.json`.
 */
function resolveConfigPath() {
  // Allow overriding the state directory (e.g. in containers with mounted volumes).
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(resolveHomeDir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

/**
 * Strips `//` and `/* *\/` comments outside string literals so a JSON5-style
 * hand-edited config (OpenClaw tolerates comments on read) still parses here.
 * Mirrors the comment detection in openclaw/src/config/json5-comments.ts;
 * writing this file back out always emits plain JSON, same as OpenClaw's own
 * config writer (which strips comments on write and only warns about it).
 *
 * This is a minimal single-pass state machine. It doesn't support nested block
 * comments or regex literals (the config file never contains those), but it
 * correctly handles `//` line comments and `/* ... *\/` block comments,
 * skipping comment syntax inside both double-quoted and single-quoted strings,
 * and respecting backslash escapes inside strings.
 *
 * @param {string} raw - The raw file contents (possibly with comments).
 * @returns {string} The contents with comments removed, strings preserved.
 */
function stripJsonComments(raw) {
  let result = "";
  // `quote` is set to '"' or "'" when inside a string, or undefined when in plain code.
  let quote;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    // --- Inside a string literal: copy characters verbatim, handle escapes ---
    if (quote) {
      result += char;
      if (char === "\\") {
        // Copy the character following a backslash (the escaped char) verbatim.
        index += 1;
        if (index < raw.length) {
          result += raw[index];
        }
      } else if (char === quote) {
        // Closing quote: exit string state.
        quote = undefined;
      }
      continue;
    }
    // --- Outside a string: detect string start or comment start ---
    // Entering a string: record the quote char and copy it.
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    // `//` line comment: skip everything until the end of the line.
    if (char === "/" && raw[index + 1] === "/") {
      while (index < raw.length && raw[index] !== "\n") {
        index += 1;
      }
      // Preserve the newline so line numbers stay aligned.
      result += "\n";
      continue;
    }
    // `/* ... *\/` block comment: skip everything until the closing `*/`.
    if (char === "/" && raw[index + 1] === "*") {
      index += 2; // Skip the opening `/*`
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
        // Preserve newlines inside block comments to avoid collapsing line structure.
        result += raw[index] === "\n" ? "\n" : "";
        index += 1;
      }
      // Skip the closing `*/` (the index ends pointing at `*`).
      index += 1;
      continue;
    }
    // Regular character outside strings and comments.
    result += char;
  }
  return result;
}

/**
 * Reads and parses the existing OpenClaw config file.
 *
 * If the file doesn't exist (`ENOENT`), returns an empty object so callers can
 * proceed with building a fresh config from scratch.
 * If the file contains JSON5-style comments that make `JSON.parse` fail, the
 * comments are stripped (preserving string literals) and parsing is retried.
 * A warning is printed to stderr so the user knows the comments will be
 * stripped in the rewritten file.
 *
 * @param {string} configPath - Absolute path to `openclaw.json`.
 * @returns {object} The parsed config object (empty `{}` if the file doesn't exist).
 * @throws {Error} Re-throws any filesystem error other than `ENOENT`.
 */
function readExistingConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    // File doesn't exist yet -- start with an empty config.
    if (error?.code === "ENOENT") {
      return {};
    }
    // Any other filesystem error (permissions, I/O, etc.) is unexpected; propagate it.
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // The file has comments or trailing commas that plain JSON.parse can't handle.
    console.error(
      `populate-openrouter-free-models: ${configPath} has JSON5-style comments; they will be stripped on write`,
    );
    return JSON.parse(stripJsonComments(raw));
  }
}

/**
 * Writes the config object to disk atomically.
 *
 * Atomicity is achieved by writing to a temporary file first, then renaming
 * it over the target path. `fs.rename` is atomic on POSIX and Windows, so a
 * crash mid-write leaves either the old or the new file intact -- never a
 * half-written one. The directory is created with `0o700` and the file with
 * `0o600` to protect any API keys or secrets that might be in the config.
 *
 * @param {string} configPath - Absolute path to `openclaw.json`.
 * @param {object} config - The config object to serialize and write.
 */
function writeConfigAtomic(configPath, config) {
  // Ensure the parent directory exists before writing (e.g. ~/.openclaw).
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  // Pretty-print as 2-space indented JSON with a trailing newline.
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  // Use a PID-suffixed temp file to avoid collisions when multiple instances run.
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  // Write with restrictive permissions to avoid leaking secrets to other users.
  fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  // Atomically replace the old config with the new one.
  fs.renameSync(tmpPath, configPath);
}

/**
 * Filters out free models whose non-free counterpart (e.g. `provider/model`
 * for `provider/model:free`) is already declared in the OpenRouter provider's
 * model list. This prevents adding a free entry when a paid/subscribed model
 * with the same catalog id already exists.
 *
 * The check compares the *base* id (the free model id with the `:free` suffix
 * stripped) against all existing model ids in the OpenRouter provider section.
 * If the base id is found, the free model is excluded from the result. Existing
 * non-free entries are left untouched and will be preserved by
 * `mergeFreeModelsIntoConfig`.
 *
 * @param {object} existingConfig - The current OpenClaw config (may be empty `{}`).
 * @param {object[]} freeModels - Free-tier model configs produced by `toModelDefinitionConfig`.
 * @returns {object[]} Free models that don't already have a paid counterpart in the config.
 */
function filterOutSubsumedFreeModels(existingConfig, freeModels) {
  // Collect every existing model id from the OpenRouter provider section into a Set
  // for O(1) lookups during filtering.
  const existingIds = new Set();
  const openrouterModels = existingConfig?.models?.providers?.openrouter?.models;
  if (Array.isArray(openrouterModels)) {
    for (const model of openrouterModels) {
      const id = model?.id;
      if (typeof id === "string") {
        existingIds.add(id);
      }
    }
  }

  // For each free model, compute the base id by stripping the ":free" suffix,
  // then exclude it if the base id is already present in the config.
  return freeModels.filter((model) => {
    // Remove the trailing ":free" to get the canonical model id (e.g. "openai/gpt-4.1").
    const baseId = model.id.endsWith(FREE_SUFFIX)
      ? model.id.slice(0, -FREE_SUFFIX.length)
      : model.id;
    // Keep the free model only if no non-free counterpart is already configured.
    return !existingIds.has(baseId);
  });
}

/**
 * Merges newly discovered free models into the config's OpenRouter provider section.
 *
 * The merge is *replace-on-tag*: all existing model entries tagged with
 * `metadataSource: "models-add"` (i.e. ones this script added on a previous run)
 * are removed and replaced with the fresh `freeModels` list. Other entries
 * (bundled catalog, hand-declared via Helm/ConfigMap) are preserved untouched.
 *
 * This function returns a *new* config object (shallow-copied at each level)
 * rather than mutating the input, so the caller can decide whether to write it.
 *
 * @param {object} config - The existing OpenClaw config object.
 * @param {object[]} freeModels - The filtered list of free models to add (already
 *   processed by `filterOutSubsumedFreeModels` if applicable).
 * @returns {object} A new config object with the free models merged in.
 */
function mergeFreeModelsIntoConfig(config, freeModels) {
  // Shallow-copy each level to avoid mutating the input config.
  const nextConfig = { ...config };
  const models = { ...nextConfig.models };
  const providers = { ...models.providers };
  const openrouter = { ...providers.openrouter };
  // Normalize existing models to an array (may be absent or undefined).
  const existingModels = Array.isArray(openrouter.models) ? openrouter.models : [];

  // Ensure the OpenRouter provider has a base URL, defaulting to the official API endpoint.
  openrouter.baseUrl ??= "https://openrouter.ai/api/v1";
  // Rebuild the models list: keep all non-script-managed entries, then append fresh free models.
  openrouter.models = [
    // Preserve existing entries that were NOT added by this script (bundled, hand-declared, etc.).
    ...existingModels.filter((model) => model?.metadataSource !== METADATA_SOURCE),
    // Append the newly discovered (and filtered) free models.
    ...freeModels,
  ];

  // Wire the modified objects back up the tree.
  providers.openrouter = openrouter;
  models.providers = providers;
  nextConfig.models = models;
  return nextConfig;
}

/**
 * Syncs discovered free models into agents.defaults.modelPolicy.allow, using
 * the same key format OpenClaw's model-selection matcher expects:
 * `${provider}/${modelId}` (see src/shared/model-key.ts). Returns
 * `{ config, updated }` -- `updated` is false when the allow list was left
 * untouched (absent/empty, meaning "any model allowed" already).
 *
 * The allow list is only modified when it already exists and is non-empty.
 * An absent/empty allow means "any model allowed" in OpenClaw; creating one
 * here would newly *restrict* access instead of only adding to it. When an
 * allow list does exist, this function replaces only the "openrouter/*:free"
 * entries it previously added and leaves every other allow entry untouched.
 *
 * @param {object} config - The OpenClaw config (must include the merged model catalog).
 * @param {object[]} freeModels - The filtered free models to sync into the allow list.
 * @returns {{ config: object, updated: boolean }} A new config with the allow list
 *   updated, and a flag indicating whether the allow list was modified.
 */
function mergeFreeModelsIntoModelPolicy(config, freeModels) {
  // Safely navigate to agents.defaults.modelPolicy.allow, defaulting to empty objects/arrays.
  const agents = config.agents ?? {};
  const defaults = agents.defaults ?? {};
  const existingAllow = defaults.modelPolicy?.allow;
  // If the allow list is absent or empty, OpenClaw treats it as "any model allowed".
  // Creating one here would *restrict* access, so we leave it untouched.
  if (!Array.isArray(existingAllow) || existingAllow.length === 0) {
    return { config, updated: false };
  }

  // Keep all allow entries that are NOT openrouter free-model refs (everything else is preserved as-is).
  const preserved = existingAllow.filter((ref) => !OPENROUTER_FREE_ALLOW_REF_RE.test(ref));
  // Build new "openrouter/<id>" refs for each free model we're adding.
  const discoveredRefs = freeModels.map((model) => `openrouter/${model.id}`);
  // Merge preserved + discovered, deduplicating with a Set to avoid duplicate refs.
  const nextAllow = [...new Set([...preserved, ...discoveredRefs])];

  // Return a new config object with the updated allow list (shallow-copied at each level).
  return {
    config: {
      ...config,
      agents: {
        ...agents,
        defaults: {
          ...defaults,
          modelPolicy: { ...defaults.modelPolicy, allow: nextAllow },
        },
      },
    },
    updated: true,
  };
}

/**
 * Entry point for the script.
 *
 * Orchestrates the full pipeline:
 *   1. Resolve API keys from the environment (no-op if none are set).
 *   2. Fetch the OpenRouter models catalog (no-op if the fetch fails).
 *   3. Filter to free-tier models only and convert them to OpenClaw config rows.
 *   4. Read the existing openclaw.json config (starts empty if the file doesn't exist).
 *   5. Remove any free models whose paid counterpart already exists in the config.
 *   6. Merge the applicable free models into the OpenRouter provider section.
 *   7. Sync the applicable free models into the model allow list (if one exists).
 *   8. Atomically write the updated config and log a summary.
 *
 * Every failure path logs to stderr and returns without throwing, so this
 * script never blocks container startup when invoked from a CMD chain.
 */
async function main() {
  // --- Step 1: Resolve API keys ---
  const apiKeys = resolveCandidateApiKeys();
  // If no keys are configured, silently skip (not an error in environments without OpenRouter access).
  if (apiKeys.length === 0) {
    console.error(
      "populate-openrouter-free-models: OPENROUTER_API_KEYS/OPENROUTER_API_KEY not set, skipping",
    );
    return;
  }

  // --- Step 2: Fetch the OpenRouter models catalog ---
  let catalog;
  try {
    // `catalog` is the `data` array from the OpenRouter /models response.
    catalog = await fetchOpenRouterModels(apiKeys);
  } catch (error) {
    // Log and skip on fetch failure -- container should still start without the free model catalog.
    console.error(`populate-openrouter-free-models: could not fetch OpenRouter catalog, skipping: ${error.message}`);
    return;
  }

  // --- Step 3: Filter to free-tier models and convert to OpenClaw rows ---
  const freeModels = catalog
    .filter((item) => isFreeOpenRouterModelId(item?.id))
    .map(toModelDefinitionConfig);

  // If the catalog returned no free models (rare but possible), skip the config update.
  if (freeModels.length === 0) {
    console.error("populate-openrouter-free-models: no ':free' OpenRouter models found, skipping");
    return;
  }

  // --- Steps 4-8: Read, filter, merge, and write config ---
  const configPath = resolveConfigPath();
  try {
    // Step 4: Read the existing config (empty object if the file doesn't exist yet).
    const existingConfig = readExistingConfig(configPath);
    // Step 5: Exclude free models that already have a paid/non-free counterpart in the config.
    const applicableFreeModels = filterOutSubsumedFreeModels(existingConfig, freeModels);
    // Step 6: Merge the applicable free models into the OpenRouter provider section.
    const withModels = mergeFreeModelsIntoConfig(existingConfig, applicableFreeModels);
    // Step 7: Sync into the model allow list (no-op if the allow list is absent/empty).
    const { config: nextConfig, updated: allowlistUpdated } = mergeFreeModelsIntoModelPolicy(
      withModels,
      applicableFreeModels,
    );
    // Step 8: Atomically write the updated config.
    writeConfigAtomic(configPath, nextConfig);

    // Log a summary: how many models were written, how many were skipped, and whether the allow list was synced.
    const skippedCount = freeModels.length - applicableFreeModels.length;
    console.error(
      `populate-openrouter-free-models: wrote ${applicableFreeModels.length} free OpenRouter model(s) to ${configPath}` +
        (skippedCount > 0
          ? ` (${skippedCount} skipped: paid/subscribed counterpart already present)`
          : "") +
        (allowlistUpdated
          ? " (also synced agents.defaults.modelPolicy.allow)"
          : " (modelPolicy.allow absent/empty, left unrestricted)"),
    );
  } catch (error) {
    // If anything goes wrong during config read/write, log and continue.
    // Never throw from main() -- this script must not block container startup.
    console.error(`populate-openrouter-free-models: could not update ${configPath}, skipping: ${error.message}`);
  }
}

// Execute the script. In Node ESM, top-level await is allowed.
await main();
