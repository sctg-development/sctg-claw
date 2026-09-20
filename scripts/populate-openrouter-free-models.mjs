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

const OPENROUTER_MODELS_URL = `${process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1"}/models`;
const FETCH_TIMEOUT_MS = 10_000;
const KEY_SPLIT_RE = /[\s,;]+/g;
const METADATA_SOURCE = "models-add";
const ALLOWED_INPUT_MODALITIES = ["text", "image", "video", "audio"];
const OPENROUTER_FREE_ALLOW_REF_RE = /^openrouter\/.+:free$/;

function parseKeyList(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(KEY_SPLIT_RE)
    .map((key) => key.trim())
    .filter(Boolean);
}

function resolveCandidateApiKeys() {
  const seen = new Set();
  for (const key of [
    ...parseKeyList(process.env.OPENROUTER_API_KEYS),
    ...parseKeyList(process.env.OPENROUTER_API_KEY),
  ]) {
    seen.add(key);
  }
  return [...seen];
}

async function fetchOpenRouterModels(apiKeys) {
  let lastError;
  for (const apiKey of apiKeys) {
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        continue;
      }
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) {
        lastError = new Error("unexpected response shape: missing data[] array");
        continue;
      }
      return payload.data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no OpenRouter API key available");
}

function numberField(item, field) {
  const value = item?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(item, field) {
  const value = item?.[field];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function isFreeOpenRouterModelId(id) {
  return typeof id === "string" && id.endsWith(":free");
}

/** Maps one OpenRouter catalog entry into an OpenClaw ModelDefinitionConfig row. */
function toModelDefinitionConfig(item) {
  const id = item.id;
  const topProvider = item.top_provider ?? {};
  const architecture = item.architecture ?? {};
  const supportedParameters = stringArrayField(item, "supported_parameters");

  const inputModalities = stringArrayField(architecture, "input_modalities")
    .map((entry) => entry.toLowerCase())
    .filter((entry) => ALLOWED_INPUT_MODALITIES.includes(entry));

  const contextWindow = numberField(topProvider, "context_length") ?? numberField(item, "context_length");
  const maxTokens =
    numberField(topProvider, "max_completion_tokens") ??
    numberField(item, "max_completion_tokens") ??
    contextWindow ??
    4096;

  return {
    id,
    name: typeof item.name === "string" && item.name.trim() ? item.name : id,
    reasoning: supportedParameters.includes("reasoning"),
    input: inputModalities.length > 0 ? inputModalities : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    maxTokens,
    metadataSource: METADATA_SOURCE,
  };
}

function resolveHomeDir() {
  return (
    process.env.OPENCLAW_HOME?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    os.homedir()
  );
}

function resolveConfigPath() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(resolveHomeDir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

/**
 * Strips `//` and `/* *\/` comments outside string literals so a JSON5-style
 * hand-edited config (OpenClaw tolerates comments on read) still parses here.
 * Mirrors the comment detection in openclaw/src/config/json5-comments.ts;
 * writing this file back out always emits plain JSON, same as OpenClaw's own
 * config writer (which strips comments on write and only warns about it).
 */
function stripJsonComments(raw) {
  let result = "";
  let quote;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      result += char;
      if (char === "\\") {
        index += 1;
        if (index < raw.length) {
          result += raw[index];
        }
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    if (char === "/" && raw[index + 1] === "/") {
      while (index < raw.length && raw[index] !== "\n") {
        index += 1;
      }
      result += "\n";
      continue;
    }
    if (char === "/" && raw[index + 1] === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
        result += raw[index] === "\n" ? "\n" : "";
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function readExistingConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(
      `populate-openrouter-free-models: ${configPath} has JSON5-style comments; they will be stripped on write`,
    );
    return JSON.parse(stripJsonComments(raw));
  }
}

function writeConfigAtomic(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

function mergeFreeModelsIntoConfig(config, freeModels) {
  const nextConfig = { ...config };
  const models = { ...nextConfig.models };
  const providers = { ...models.providers };
  const openrouter = { ...providers.openrouter };
  const existingModels = Array.isArray(openrouter.models) ? openrouter.models : [];

  openrouter.baseUrl ??= "https://openrouter.ai/api/v1";
  openrouter.models = [
    ...existingModels.filter((model) => model?.metadataSource !== METADATA_SOURCE),
    ...freeModels,
  ];

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
 */
function mergeFreeModelsIntoModelPolicy(config, freeModels) {
  const agents = config.agents ?? {};
  const defaults = agents.defaults ?? {};
  const existingAllow = defaults.modelPolicy?.allow;
  if (!Array.isArray(existingAllow) || existingAllow.length === 0) {
    return { config, updated: false };
  }

  const preserved = existingAllow.filter((ref) => !OPENROUTER_FREE_ALLOW_REF_RE.test(ref));
  const discoveredRefs = freeModels.map((model) => `openrouter/${model.id}`);
  const nextAllow = [...new Set([...preserved, ...discoveredRefs])];

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

async function main() {
  const apiKeys = resolveCandidateApiKeys();
  if (apiKeys.length === 0) {
    console.error(
      "populate-openrouter-free-models: OPENROUTER_API_KEYS/OPENROUTER_API_KEY not set, skipping",
    );
    return;
  }

  let catalog;
  try {
    catalog = await fetchOpenRouterModels(apiKeys);
  } catch (error) {
    console.error(`populate-openrouter-free-models: could not fetch OpenRouter catalog, skipping: ${error.message}`);
    return;
  }

  const freeModels = catalog
    .filter((item) => isFreeOpenRouterModelId(item?.id))
    .map(toModelDefinitionConfig);

  if (freeModels.length === 0) {
    console.error("populate-openrouter-free-models: no ':free' OpenRouter models found, skipping");
    return;
  }

  const configPath = resolveConfigPath();
  try {
    const existingConfig = readExistingConfig(configPath);
    const withModels = mergeFreeModelsIntoConfig(existingConfig, freeModels);
    const { config: nextConfig, updated: allowlistUpdated } = mergeFreeModelsIntoModelPolicy(
      withModels,
      freeModels,
    );
    writeConfigAtomic(configPath, nextConfig);
    console.error(
      `populate-openrouter-free-models: wrote ${freeModels.length} free OpenRouter model(s) to ${configPath}` +
        (allowlistUpdated
          ? " (also synced agents.defaults.modelPolicy.allow)"
          : " (modelPolicy.allow absent/empty, left unrestricted)"),
    );
  } catch (error) {
    console.error(`populate-openrouter-free-models: could not update ${configPath}, skipping: ${error.message}`);
  }
}

await main();
