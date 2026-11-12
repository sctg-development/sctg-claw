#!/usr/bin/env node
// Verifies and adapts <state-dir>/openclaw.json at every container start, before `doctor --fix`.
//
// Why: the chart renders openclaw.json once, on first boot. After that the file drifts from the image
// (a provider the image now ships is missing from the model allow-list, a model id was retired by its
// vendor) and from the operator's intent (settings declared in the chart never reach an existing
// volume). This script reconciles the file, conservatively:
//
//   1. RETIRED_MODEL_REFS: a retired model ref is replaced by its successor wherever it appears (list
//      items, object values, object keys). Only refs confirmed gone from the vendor catalog belong here.
//   2. REQUIRED_ALLOWED: provider wildcards the image ships are added to agents.defaults.modelPolicy.allow
//      IF that list is active. An absent or empty list means "any model allowed"; creating one would
//      newly restrict the agent, so it is never created here.
//   3. OPENCLAW_CONFIG_OVERRIDES: a JSON object (chart value `openclaw.configOverrides`) deep-merged over
//      the file at every start. Objects merge, arrays and scalars are replaced. These keys are MANAGED:
//      an edit made to them in the UI is reverted at the next restart. Put secrets behind SecretRefs.
//
// It never creates the file (a missing file is the first boot, the chart seeds it), never touches a file
// that is not strict JSON, writes only when something changed (atomically, after keeping one backup,
// `openclaw.json.pre-reconcile.bak`), logs the path of every change but never an override value, and
// never fails the start: every problem is a warning and the exit code is 0.
//
// Env: OPENCLAW_STATE_DIR (default ~/.openclaw), OPENCLAW_CONFIG_OVERRIDES, RECONCILE_DRY_RUN=1.
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Refs that no longer resolve -> their successor. Each entry was checked against the live provider
 * catalog (claude-haiku-4-5 is gone from it) or confirmed by the operator (the malformed `opus-5`).
 */
export const RETIRED_MODEL_REFS = {
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-5-5",
  "anthropic/opus-5": "anthropic/claude-opus-5-5",
};

/** Provider wildcards this image ships and that must stay allowed when an allow-list is active. */
export const REQUIRED_ALLOWED = ["vibe/*"];

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Replace retired refs in place. Returns nothing; pushes a human line per change into `changes`. */
export function replaceRetiredRefs(node, retired, changes, here = "$") {
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i -= 1) {
      const item = node[i];
      if (typeof item === "string" && Object.hasOwn(retired, item)) {
        const next = retired[item];
        if (node.includes(next)) {
          node.splice(i, 1);
          changes.push(`removed retired ${item} from ${here} (${next} already there)`);
        } else {
          node[i] = next;
          changes.push(`replaced ${item} with ${next} in ${here}[${i}]`);
        }
      } else {
        replaceRetiredRefs(item, retired, changes, `${here}[${i}]`);
      }
    }
    return;
  }
  if (!isObject(node)) {
    return;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Object.hasOwn(retired, key)) {
      const next = retired[key];
      delete node[key];
      if (Object.hasOwn(node, next)) {
        changes.push(`removed retired key ${key} from ${here} (${next} already there)`);
      } else {
        node[next] = value;
        changes.push(`renamed key ${key} to ${next} in ${here}`);
        replaceRetiredRefs(node[next], retired, changes, `${here}.${next}`);
      }
    } else if (typeof value === "string" && Object.hasOwn(retired, value)) {
      node[key] = retired[value];
      changes.push(`replaced ${value} with ${retired[value]} at ${here}.${key}`);
    } else {
      replaceRetiredRefs(value, retired, changes, `${here}.${key}`);
    }
  }
}

/** Add required wildcards to an ACTIVE allow-list only. */
export function ensureAllowed(cfg, required, changes) {
  const allow = cfg?.agents?.defaults?.modelPolicy?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return;
  }
  for (const entry of required) {
    if (!allow.includes(entry)) {
      allow.push(entry);
      changes.push(`added ${entry} to agents.defaults.modelPolicy.allow`);
    }
  }
}

/** Deep-merge `patch` into `target`. Objects merge; arrays and scalars replace. Values are never logged. */
export function applyOverrides(target, patch, changes, here = "") {
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) {
      changes.push(`ignored unsafe override key ${key}`);
      continue;
    }
    const at = here ? `${here}.${key}` : key;
    if (isObject(value) && isObject(target[key])) {
      applyOverrides(target[key], value, changes, at);
    } else if (!same(target[key], value)) {
      target[key] = structuredClone(value);
      changes.push(`override ${at}`);
    }
  }
}

/** Pure: returns the change list and mutates `cfg`. Order matters: overrides are applied last and win. */
export function reconcile(cfg, { overrides, retired = RETIRED_MODEL_REFS, required = REQUIRED_ALLOWED } = {}) {
  const changes = [];
  replaceRetiredRefs(cfg, retired, changes);
  ensureAllowed(cfg, required, changes);
  if (overrides) {
    applyOverrides(cfg, overrides, changes);
  }
  return changes;
}

/** Parses OPENCLAW_CONFIG_OVERRIDES. Returns { overrides } or { error }. */
export function parseOverrides(raw) {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "{}") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? { overrides: parsed } : { error: "must be a JSON object" };
  } catch (error) {
    return { error: error.message };
  }
}

function writeAtomically(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function main() {
  const env = process.env;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(env.HOME || os.homedir(), ".openclaw");
  const file = path.join(stateDir, "openclaw.json");
  const log = (message) => console.error(`reconcile-openclaw-config: ${message}`);

  if (!existsSync(file)) {
    return; // first boot: the chart seeds the file
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    log(`${file} is not strict JSON (${error.message.slice(0, 80)}), left untouched`);
    return;
  }
  if (!isObject(cfg)) {
    log(`${file} is not a JSON object, left untouched`);
    return;
  }

  const parsed = parseOverrides(env.OPENCLAW_CONFIG_OVERRIDES);
  if (parsed.error) {
    log(`OPENCLAW_CONFIG_OVERRIDES ignored: ${parsed.error}`);
  }
  const changes = reconcile(cfg, { overrides: parsed.overrides });
  if (changes.length === 0) {
    log("config already matches, nothing to change");
    return;
  }
  for (const change of changes) {
    log(change);
  }
  if (env.RECONCILE_DRY_RUN === "1") {
    log(`dry run: ${changes.length} change(s) not written`);
    return;
  }
  try {
    copyFileSync(file, `${file}.pre-reconcile.bak`);
    chmodSync(`${file}.pre-reconcile.bak`, 0o600);
    writeAtomically(file, `${JSON.stringify(cfg, null, 2)}\n`);
    log(`wrote ${changes.length} change(s), previous file kept as openclaw.json.pre-reconcile.bak`);
  } catch (error) {
    log(`could not write ${file}: ${error.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
