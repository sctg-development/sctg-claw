import assert from "node:assert/strict";
import { test } from "node:test";
import { changedVars, mayRestart, renderEnvFile } from "./keypool-refresh.mjs";

test("changedVars reports only differing or new vault variables", () => {
  const applied = { MISTRAL_API_KEYS: "a,b", HOME: "/x", EXA_API_KEYS: "e" };
  const desired = { MISTRAL_API_KEYS: "a,b", EXA_API_KEYS: "e2", COHERE_API_KEYS: "c" };
  assert.deepEqual(changedVars(applied, desired), ["COHERE_API_KEYS", "EXA_API_KEYS"]);
  assert.deepEqual(changedVars(applied, { MISTRAL_API_KEYS: "a,b" }), []);
});

test("renderEnvFile quotes values and contains only what it is given", () => {
  assert.equal(renderEnvFile({ A: "x'y", B: "z" }), "export A='x'\\''y'\nexport B='z'\n");
});

test("restart gate honours the minimum gap", () => {
  assert.equal(mayRestart(1000, undefined, 600_000), true);
  assert.equal(mayRestart(1000 + 599_999, 1000, 600_000), false);
  assert.equal(mayRestart(1000 + 600_000, 1000, 600_000), true);
});
