import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyOverrides,
  ensureAllowed,
  parseOverrides,
  reconcile,
  replaceRetiredRefs,
} from "./reconcile-openclaw-config.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "reconcile-openclaw-config.mjs");
const RETIRED = { "old/model": "new/model" };

test("retired refs: replaced in arrays, deduplicated when the successor is already there", () => {
  const cfg = { a: ["x", "old/model", "y"], b: ["old/model", "new/model"] };
  const changes = [];
  replaceRetiredRefs(cfg, RETIRED, changes);
  assert.deepEqual(cfg.a, ["x", "new/model", "y"]);
  assert.deepEqual(cfg.b, ["new/model"]);
  assert.equal(changes.length, 2);
});

test("retired refs: scalar values and object keys are migrated, nested values kept", () => {
  const cfg = { primary: "old/model", models: { "old/model": { runtime: "r" }, other: { fallbacks: ["old/model"] } } };
  replaceRetiredRefs(cfg, RETIRED, []);
  assert.equal(cfg.primary, "new/model");
  assert.deepEqual(cfg.models["new/model"], { runtime: "r" });
  assert.equal("old/model" in cfg.models, false);
  assert.deepEqual(cfg.models.other.fallbacks, ["new/model"]);
});

test("retired refs: an existing successor key wins, the stale key is dropped", () => {
  const cfg = { models: { "old/model": { v: "old" }, "new/model": { v: "new" } } };
  replaceRetiredRefs(cfg, RETIRED, []);
  assert.deepEqual(cfg.models, { "new/model": { v: "new" } });
});

test("ensureAllowed adds to an active list only: never creates or fills an empty one", () => {
  const active = { agents: { defaults: { modelPolicy: { allow: ["a/*"] } } } };
  ensureAllowed(active, ["vibe/*"], []);
  assert.deepEqual(active.agents.defaults.modelPolicy.allow, ["a/*", "vibe/*"]);
  for (const cfg of [{}, { agents: { defaults: { modelPolicy: {} } } }, { agents: { defaults: { modelPolicy: { allow: [] } } } }]) {
    const before = JSON.stringify(cfg);
    ensureAllowed(cfg, ["vibe/*"], []);
    assert.equal(JSON.stringify(cfg), before, "must not restrict an agent that currently allows everything");
  }
});

test("overrides: objects merge, arrays and scalars replace, identical values are no-ops", () => {
  const cfg = { p: { keep: 1, list: [1, 2], s: "a" } };
  const changes = [];
  applyOverrides(cfg, { p: { list: [3], s: "a", n: { deep: true } } }, changes);
  assert.deepEqual(cfg, { p: { keep: 1, list: [3], s: "a", n: { deep: true } } });
  assert.deepEqual(changes, ["override p.list", "override p.n"]);
  const again = [];
  applyOverrides(cfg, { p: { list: [3], s: "a", n: { deep: true } } }, again);
  assert.deepEqual(again, []);
});

test("overrides cannot pollute prototypes", () => {
  const cfg = {};
  const changes = [];
  applyOverrides(cfg, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":1}'), changes);
  assert.equal({}.polluted, undefined);
  assert.equal(cfg.ok, 1);
  assert.equal(changes.filter((c) => c.startsWith("ignored")).length, 2);
});

test("parseOverrides: empty is fine, bad JSON or a non-object is an error", () => {
  assert.deepEqual(parseOverrides(undefined), {});
  assert.deepEqual(parseOverrides("  "), {});
  assert.ok(parseOverrides("{nope").error);
  assert.ok(parseOverrides("[1]").error);
  assert.deepEqual(parseOverrides('{"a":1}'), { overrides: { a: 1 } });
});

test("reconcile on the real-world drift: both retired refs replaced, vibe/* added, the rest untouched", () => {
  const cfg = {
    agents: {
      defaults: { modelPolicy: { allow: ["acp-vibe/*", "anthropic/opus-5", "anthropic/claude-haiku-4-5", "openrouter/x/y:free"] } },
      entries: { main: { model: { primary: "openrouter/x/y:free", fallbacks: ["anthropic/claude-haiku-4-5", "mistral/small"] } } },
    },
  };
  const changes = reconcile(cfg);
  assert.deepEqual(cfg.agents.defaults.modelPolicy.allow, [
    "acp-vibe/*",
    "anthropic/claude-opus-5-5",
    "anthropic/claude-haiku-5-5",
    "openrouter/x/y:free",
    "vibe/*",
  ]);
  assert.deepEqual(cfg.agents.entries.main.model.fallbacks, ["anthropic/claude-haiku-5-5", "mistral/small"]);
  assert.equal(changes.length, 4);
});

// --- the script itself, on a temporary state dir ------------------------------------------------
function stateDir(content) {
  const dir = mkdtempSync(path.join(tmpdir(), "reconcile-"));
  if (content !== undefined) {
    writeFileSync(path.join(dir, "openclaw.json"), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const runScript = (dir, env = {}) =>
  spawnSync("node", [script], { env: { PATH: process.env.PATH, OPENCLAW_STATE_DIR: dir, ...env }, encoding: "utf8" });
const read = (dir) => JSON.parse(readFileSync(path.join(dir, "openclaw.json"), "utf8"));

const DRIFTED = { agents: { defaults: { modelPolicy: { allow: ["anthropic/claude-haiku-4-5"] } } }, keep: { me: true } };


test("script: fixes the file, keeps a 0600 backup, and a second start changes nothing", () => {
  const dir = stateDir(DRIFTED);
  const first = runScript(dir);
  assert.equal(first.status, 0);
  assert.deepEqual(read(dir).agents.defaults.modelPolicy.allow, ["anthropic/claude-haiku-5-5", "vibe/*"]);
  assert.deepEqual(read(dir).keep, { me: true });
  const backup = path.join(dir, "openclaw.json.pre-reconcile.bak");
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), DRIFTED);
  assert.equal(statSync(path.join(dir, "openclaw.json")).mode & 0o777, 0o600);
  const before = readFileSync(path.join(dir, "openclaw.json"), "utf8");
  const second = runScript(dir);
  assert.match(second.stderr, /nothing to change/);
  assert.equal(readFileSync(path.join(dir, "openclaw.json"), "utf8"), before);
});

test("script: missing file (first boot) is left alone; invalid JSON is never rewritten", () => {
  const none = stateDir();
  assert.equal(runScript(none).status, 0);
  assert.equal(existsSync(path.join(none, "openclaw.json")), false);
  const broken = stateDir("{ // json5 comment\n a: 1 }");
  const r = runScript(broken);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /not strict JSON/);
  assert.equal(readFileSync(path.join(broken, "openclaw.json"), "utf8"), "{ // json5 comment\n a: 1 }");
});

test("script: overrides are applied, and their values never reach the logs", () => {
  const dir = stateDir({ plugins: { entries: { "sctg-mail": { enabled: true } } } });
  const r = runScript(dir, {
    OPENCLAW_CONFIG_OVERRIDES: JSON.stringify({ plugins: { entries: { "sctg-mail": { config: { defaultAccount: "sender@example.org" } } } } }),
  });
  assert.equal(read(dir).plugins.entries["sctg-mail"].config.defaultAccount, "sender@example.org");
  assert.equal(read(dir).plugins.entries["sctg-mail"].enabled, true);
  assert.match(r.stderr, /override plugins\.entries\.sctg-mail\.config/);
  assert.ok(!r.stderr.includes("sender@example.org"), "override values must not be logged");
});

test("script: a bad overrides variable is ignored without breaking the start", () => {
  const dir = stateDir(DRIFTED);
  const r = runScript(dir, { OPENCLAW_CONFIG_OVERRIDES: "{not json" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /OPENCLAW_CONFIG_OVERRIDES ignored/);
  assert.deepEqual(read(dir).agents.defaults.modelPolicy.allow, ["anthropic/claude-haiku-5-5", "vibe/*"]);
});

test("script: dry run reports but writes nothing", () => {
  const dir = stateDir(DRIFTED);
  const r = runScript(dir, { RECONCILE_DRY_RUN: "1" });
  assert.match(r.stderr, /dry run/);
  assert.deepEqual(read(dir), DRIFTED);
  assert.equal(existsSync(path.join(dir, "openclaw.json.pre-reconcile.bak")), false);
});
