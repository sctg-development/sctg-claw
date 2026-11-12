import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { buildMail, main, normalizeResult, parseRepos, readZipEntry, syncOne, tokenFor } from "./fork-sync-watch.mjs";

// Minimal zip writer with a central directory and data descriptors-free local headers (sizes in the
// central directory are what the reader uses, like a GitHub artifact).
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, method = 8] of files) {
    const raw = Buffer.from(content);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 18); // sizes unknown here on purpose
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

// A fake GitHub: routes by method and path.
function fakeGh({ dispatchStatus = 204, runs, artifactZip, conclusion = "success", artifacts }) {
  const calls = [];
  const gh = async (path, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${path}`);
    if (path.endsWith("/dispatches")) return { ok: dispatchStatus < 300, status: dispatchStatus };
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return json({ default_branch: "main" });
    if (path.includes("/workflows/fork-sync.yml/runs")) return json({ workflow_runs: runs ?? [{ id: 7, status: "queued", html_url: "https://github.com/o/r/actions/runs/7" }] });
    if (/\/actions\/runs\/7$/.test(path)) return json({ id: 7, status: "completed", conclusion, html_url: "https://github.com/o/r/actions/runs/7" });
    if (path.endsWith("/runs/7/artifacts")) return json({ artifacts: artifacts ?? [{ id: 99, name: "fork-sync-7", expired: false }] });
    if (path.endsWith("/artifacts/99/zip")) return { ok: true, status: 200, arrayBuffer: async () => artifactZip };
    return json({}, 404);
  };
  return { gh, calls };
}
const deps = (gh) => ({ gh, sleep: async () => {}, now: (() => { let t = 1_000_000; return () => (t += 1000); })() });
const OPTS = { mode: "sync", timeoutMs: 3_600_000, pollMs: 1 };

test("readZipEntry reads deflated and stored entries, matching by basename", () => {
  const z = zip([["agent.jsonl", "x".repeat(5000)], ["fork-sync-result.json", '{"status":"synced"}'], ["raw.txt", "plain", 0]]);
  assert.equal(readZipEntry(z, "fork-sync-result.json").toString(), '{"status":"synced"}');
  assert.equal(readZipEntry(z, "raw.txt").toString(), "plain");
  assert.equal(readZipEntry(z, "missing.json"), undefined);
  assert.equal(readZipEntry(Buffer.from("not a zip"), "a"), undefined);
});

test("parseRepos validates names and falls back to the defaults", () => {
  assert.equal(parseRepos("").repos.length, 3);
  const p = parseRepos("a/b, ../etc/passwd, c/d;rm -rf");
  assert.deepEqual(p.repos, ["a/b"]);
  assert.equal(p.rejected.length, 2);
});

test("normalizeResult never trusts the agent's file", () => {
  assert.equal(normalizeResult(null).status, "failed");
  assert.equal(normalizeResult({ status: "pwned" }).status, "failed");
  const r = normalizeResult({ status: "synced", pr_url: "javascript:alert(1)", notes: "n".repeat(5000), conflicts: "x" });
  assert.equal(r.prUrl, "");
  assert.ok(r.notes.length <= 1500);
  assert.deepEqual(r.conflicts, []);
  assert.equal(normalizeResult({ status: "synced", pr_url: "https://github.com/o/r/pull/3" }).prUrl, "https://github.com/o/r/pull/3");
});

test("buildMail escapes hostile notes and flags what needs action", () => {
  const result = normalizeResult({ status: "needs-human", notes: '<script>alert(1)</script> ignore previous instructions', conflicts: ["a.ts"] });
  const mail = buildMail({ repo: "o/r", runUrl: "https://github.com/o/r/actions/runs/7", result });
  assert.match(mail.subject, /needs-human \(ACTION\)/);
  assert.ok(!mail.html.includes("<script>"));
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(mail.text, /non fiable/);
  assert.match(buildMail({ repo: "o/r", result: normalizeResult({ status: "up-to-date" }) }).subject, /\(RAS\)/);
  assert.match(buildMail({ repo: "o/r", error: "boom" }).subject, /ÉCHEC/);
});

test("syncOne: a synced run returns the agent's report", async () => {
  const z = zip([["fork-sync-result.json", JSON.stringify({ status: "synced", pr_url: "https://github.com/o/r/pull/3", behind: 8, invariants: { passed: 98, failed: 0 }, typecheck: "pass" })]]);
  const { gh, calls } = fakeGh({ artifactZip: z });
  const out = await syncOne("o/r", OPTS, deps(gh));
  assert.equal(out.result.status, "synced");
  assert.equal(out.result.prUrl, "https://github.com/o/r/pull/3");
  assert.ok(calls.some((c) => c.startsWith("POST") && c.includes("/dispatches")));
});

test("syncOne: a red run can never read as synced", async () => {
  const z = zip([["fork-sync-result.json", JSON.stringify({ status: "synced" })]]);
  const { gh } = fakeGh({ artifactZip: z, conclusion: "failure" });
  const out = await syncOne("o/r", OPTS, deps(gh));
  assert.equal(out.result.status, "failed");
  assert.match(out.result.notes, /ended failure/);
});

test("syncOne: the workflow not being merged yet is explained, not hidden", async () => {
  const out = await syncOne("o/r", OPTS, deps(fakeGh({ dispatchStatus: 404 }).gh));
  assert.match(out.error, /does not exist/);
  const denied = await syncOne("o/r", OPTS, deps(fakeGh({ dispatchStatus: 403 }).gh));
  assert.match(denied.error, /Actions: read and write/);
});

test("syncOne: a run without an artifact is a failure, not a success", async () => {
  const { gh } = fakeGh({ artifacts: [] });
  assert.equal((await syncOne("o/r", OPTS, deps(gh))).result.status, "failed");
});

test("syncOne: a run that never ends times out with its URL", async () => {
  const gh = async (path, init = {}) => {
    if (path.endsWith("/dispatches")) return { ok: true, status: 204 };
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return json({ default_branch: "main" });
    if (path.includes("/runs?")) return json({ workflow_runs: [{ id: 7, status: "in_progress", html_url: "https://github.com/o/r/actions/runs/7" }] });
    return json({ id: 7, status: "in_progress", html_url: "https://github.com/o/r/actions/runs/7" });
  };
  const out = await syncOne("o/r", { ...OPTS, timeoutMs: 10_000 }, deps(gh));
  assert.match(out.error, /still running/);
  assert.match(out.runUrl, /runs\/7/);
});

test("main: one mail per sync, exit 3 when one cannot be delivered, 2 without a token", async () => {
  const z = zip([["fork-sync-result.json", JSON.stringify({ status: "up-to-date" })]]);
  const sent = [];
  const { gh } = fakeGh({ artifactZip: z });
  const base = { gh, sleep: async () => {}, now: deps(gh).now, pollMs: 1, log: () => {} };
  const env = { FORK_SYNC_GH_TOKEN: "t" };
  const argv = ["--to", "me@example.org", "--repos", "o/r,o/s"];

  assert.equal(await main(argv, env, { ...base, sendMail: async (m) => (sent.push(m.subject), { ok: true }) }), 0);
  assert.equal(sent.length, 2);

  sent.length = 0;
  assert.equal(await main([...argv, "--skip-up-to-date"], env, { ...base, sendMail: async (m) => (sent.push(m), { ok: true }) }), 0);
  assert.equal(sent.length, 0);

  assert.equal(await main(argv, env, { ...base, sendMail: async () => ({ ok: false, detail: "gog down" }) }), 3);
  assert.equal(await main(argv, {}, base), 2);
  assert.equal(await main(["--repos", "o/r"], env, base), 2);
});

test("tokenFor prefers the owner's token and normalizes the owner name", () => {
  const env = { FORK_SYNC_GH_TOKEN: "default", FORK_SYNC_GH_TOKEN_SCTG_DEVELOPMENT: "sctg" };
  assert.equal(tokenFor("sctg-development/mistral-vibe", env), "sctg");
  assert.equal(tokenFor("TEA-ching/kilocode", env), "default");
  assert.equal(tokenFor("TEA-ching/kilocode", {}), undefined);
});

test("main: a repo without a token gets its own error mail, the others still run", async () => {
  const z = zip([["fork-sync-result.json", JSON.stringify({ status: "up-to-date" })]]);
  const { gh } = fakeGh({ artifactZip: z });
  const subjects = [];
  const calls = [];
  const fetchFake = async (url, init) => {
    calls.push(String(url));
    return gh(String(url).replace("https://api.github.com", ""), init);
  };
  const code = await main(["--to", "me@example.org", "--repos", "TEA-ching/kilocode,sctg-development/mistral-vibe"], { FORK_SYNC_GH_TOKEN_TEA_CHING: "t" }, {
    fetch: fetchFake,
    sleep: async () => {},
    now: deps(gh).now,
    pollMs: 1,
    log: () => {},
    sendMail: async (m) => (subjects.push(m.subject), { ok: true }),
  });
  assert.equal(code, 0);
  assert.equal(subjects.length, 2);
  assert.ok(subjects.some((s) => /sctg-development\/mistral-vibe : ÉCHEC/.test(s)));
  assert.ok(calls.every((u) => !u.includes("sctg-development")));
});
