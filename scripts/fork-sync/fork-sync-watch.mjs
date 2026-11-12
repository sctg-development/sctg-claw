#!/usr/bin/env node
// Starts the `fork-sync` GitHub Actions workflow on each fork, follows the run, and sends ONE e-mail per
// sync with what the agent reported. Meant for an OpenClaw command cron job (no AI in the loop, so it keeps
// working when the model is unreachable):
//
//   openclaw cron add --name fork-sync-watch --display-name "Synchro des forks" --every 7d \
//     --declaration-key fork-sync-watch \
//     --command 'node /opt/fork-sync/fork-sync-watch.mjs --to <recipient> --account <gog-sender>'
//
// The GitHub side never merges anything: the workflow opens a DRAFT pull request and stops.
//
// Env:
//   FORK_SYNC_GH_TOKEN   fine-grained token, ONLY "Actions: read and write" on the forks listed below. A
//                        fine-grained token belongs to ONE owner, so forks under another owner use
//                        FORK_SYNC_GH_TOKEN_<OWNER> (owner upper-cased, other characters become "_"), which
//                        takes precedence over the default token for that owner's repositories.
//   FORK_SYNC_REPOS      comma list of owner/name, default: the three forks.
//   SCTG_MAIL_CLI        default /opt/sctg-mail/dist/cli.js
//
// Options: --to <a,b> (required)  --account <sender>  --mode sync|dry-run (default sync)
//          --repos <list>  --timeout-min <n> (default 180)  --skip-up-to-date  --dry-mail (print, send nothing)
//
// Exit codes: 0 done, 2 bad usage or missing token, 3 at least one mail could not be delivered.
//
// The agent's `notes` are derived from upstream content, which is untrusted: they are shown as escaped,
// truncated plain text, never as markup, and never executed or followed.
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const DEFAULT_REPOS = ["TEA-ching/kilocode", "TEA-ching/openclaw", "sctg-development/mistral-vibe"];
const WORKFLOW = "fork-sync.yml";
const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Pure: the token for a repo: FORK_SYNC_GH_TOKEN_<OWNER> first, then FORK_SYNC_GH_TOKEN. */
export function tokenFor(repo, env) {
  const owner = repo.split("/")[0].toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return env[`FORK_SYNC_GH_TOKEN_${owner}`] || env.FORK_SYNC_GH_TOKEN || undefined;
}

/** Pure: validates the repository list. Anything that is not owner/name is dropped and reported. */
export function parseRepos(raw) {
  const wanted = (raw ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  const list = wanted.length ? wanted : DEFAULT_REPOS;
  return { repos: list.filter((r) => REPO_RE.test(r)), rejected: list.filter((r) => !REPO_RE.test(r)) };
}

/**
 * Pure: reads one entry of a zip archive (a GitHub artifact) without any dependency. Uses the central
 * directory, because GitHub writes data descriptors and the local headers carry no sizes.
 */
export function readZipEntry(zip, name) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    return undefined;
  }
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) {
      return undefined;
    }
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.toString("utf8", at + 46, at + 46 + nameLen);
    if (entry === name || entry.endsWith(`/${name}`)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : method === 8 ? inflateRawSync(data) : undefined;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

/** Pure: the agent's result file -> a normalized report. Never trusts shapes or sizes. */
export function normalizeResult(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const known = ["synced", "needs-human", "failed", "dry-run", "up-to-date", "skipped"];
  const prUrl = typeof r.pr_url === "string" && /^https:\/\/github\.com\/[^\s]+$/.test(r.pr_url) ? r.pr_url : "";
  return {
    status: known.includes(r.status) ? r.status : "failed",
    branch: clip(r.branch, 120),
    prUrl,
    behind: Number.isFinite(r.behind) ? r.behind : undefined,
    conflicts: Array.isArray(r.conflicts) ? r.conflicts.slice(0, 40).map((c) => clip(c, 200)) : [],
    invariants:
      r.invariants && typeof r.invariants === "object"
        ? { passed: Number(r.invariants.passed) || 0, failed: Number(r.invariants.failed) || 0 }
        : undefined,
    typecheck: clip(r.typecheck, 20),
    notes: clip(r.notes, 1500),
    reason: clip(r.reason, 60),
  };
}

const HEADLINE = {
  synced: "Synchronisation prête (PR en brouillon à relire)",
  "needs-human": "L'agent s'est arrêté : une décision humaine est nécessaire",
  failed: "Échec de la synchronisation",
  "dry-run": "Essai à blanc terminé (rien n'a été modifié)",
  "up-to-date": "Le fork est déjà à jour",
  skipped: "Rien à faire",
};

/** Pure: builds the e-mail. `outcome` = { repo, runUrl, conclusion, result } or { repo, error }. */
export function buildMail(outcome) {
  const { repo } = outcome;
  if (outcome.error) {
    const subject = `[fork-sync] ${repo} : ÉCHEC avant la fin du run`;
    const text = `La synchronisation de ${repo} n'a pas pu être suivie jusqu'au bout.\n\nCause : ${clip(outcome.error, 400)}\n${outcome.runUrl ? `Run : ${outcome.runUrl}\n` : ""}`;
    return { subject, text, html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` };
  }
  const r = outcome.result;
  const flag = r.status === "synced" ? "à relire" : r.status === "up-to-date" || r.status === "skipped" ? "RAS" : "ACTION";
  const subject = `[fork-sync] ${repo} : ${r.status} (${flag})`;
  const rows = [["Fork", repo], ["Résultat", HEADLINE[r.status]]];
  if (r.behind !== undefined) rows.push(["Commits amont en retard", String(r.behind)]);
  if (r.prUrl) rows.push(["Pull request (brouillon)", r.prUrl]);
  if (r.branch) rows.push(["Branche", r.branch]);
  if (r.conflicts.length) rows.push([`Fichiers en conflit (${r.conflicts.length})`, r.conflicts.join(", ")]);
  if (r.invariants) rows.push(["Invariants du fork", `${r.invariants.passed} réussis, ${r.invariants.failed} échecs`]);
  if (r.typecheck) rows.push(["Typage", r.typecheck]);
  if (outcome.runUrl) rows.push(["Run GitHub Actions", outcome.runUrl]);
  const tail =
    r.status === "synced"
      ? "L'agent ne fusionne jamais : relisez la PR, puis fusionnez-la avec « Create a merge commit »."
      : r.status === "needs-human" || r.status === "failed"
        ? "Rien n'a été fusionné. Ouvrez le run pour le détail."
        : "";
  const text = [
    ...rows.map(([k, v]) => `${k} : ${v}`),
    r.notes ? `\nNotes de l'agent (texte non fiable, issu du contenu amont) :\n${r.notes}` : "",
    tail ? `\n${tail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<table style="border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0"><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`)
    .join("")}</table>${r.notes ? `<p><b>Notes de l'agent</b> (texte non fiable, issu du contenu amont) :<br>${escapeHtml(r.notes)}</p>` : ""}${tail ? `<p>${escapeHtml(tail)}</p>` : ""}`;
  return { subject, text, html };
}

function github(token, doFetch) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sctg-fork-sync-watch",
  };
  return async (path, init = {}) => {
    const response = await doFetch(path.startsWith("http") ? path : `${API}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
    return response;
  };
}

/**
 * Dispatches the workflow on one repo and follows it to the end.
 * Returns { repo, runUrl, conclusion, result } or { repo, error, runUrl? }. Never throws.
 */
export async function syncOne(repo, options, deps) {
  const { gh, sleep, now } = deps;
  const { mode, timeoutMs, pollMs } = options;
  const fail = (error, runUrl) => ({ repo, error, ...(runUrl ? { runUrl } : {}) });
  try {
    const info = await gh(`/repos/${repo}`);
    if (!info.ok) return fail(`repository not readable (HTTP ${info.status}); check the token's repository access`);
    const ref = (await info.json()).default_branch;
    const startedAt = now();
    const dispatch = await gh(`/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref, inputs: { mode } }),
    });
    if (dispatch.status === 404) return fail(`${WORKFLOW} does not exist on ${ref} yet (merge the pull request that adds it)`);
    if (dispatch.status !== 204) return fail(`dispatch refused (HTTP ${dispatch.status}); the token needs "Actions: read and write"`);

    // The dispatch returns no run id: find the run created from now on.
    let run;
    const since = new Date(startedAt - 15_000).toISOString();
    while (!run && now() - startedAt < 5 * 60_000) {
      await sleep(pollMs);
      const list = await gh(
        `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&created=%3E%3D${encodeURIComponent(since)}&per_page=5`,
      );
      if (list.ok) run = (await list.json()).workflow_runs?.sort((a, b) => b.id - a.id)[0];
    }
    if (!run) return fail("the dispatched run never appeared");

    let current = run;
    while (current.status !== "completed") {
      if (now() - startedAt > timeoutMs) return fail(`still running after ${Math.round(timeoutMs / 60_000)} minutes`, current.html_url);
      await sleep(pollMs);
      const again = await gh(`/repos/${repo}/actions/runs/${run.id}`);
      if (again.ok) current = await again.json();
    }

    const arts = await gh(`/repos/${repo}/actions/runs/${run.id}/artifacts`);
    const artifact = arts.ok ? (await arts.json()).artifacts?.find((a) => a.name === `fork-sync-${run.id}` && !a.expired) : undefined;
    if (!artifact) return { repo, runUrl: current.html_url, conclusion: current.conclusion, result: normalizeResult({ status: "failed", notes: "The run left no result file." }) };
    const zip = await gh(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`);
    if (!zip.ok) return fail(`result artifact not downloadable (HTTP ${zip.status})`, current.html_url);
    const entry = readZipEntry(Buffer.from(await zip.arrayBuffer()), "fork-sync-result.json");
    let parsed;
    try {
      parsed = entry ? JSON.parse(entry.toString("utf8")) : undefined;
    } catch {
      parsed = undefined;
    }
    const result = normalizeResult(parsed ?? { status: "failed", notes: "The result file was missing or not valid JSON." });
    // A red run must never read as a success, whatever the file says.
    if (current.conclusion !== "success" && result.status === "synced") {
      result.status = "failed";
      result.notes = `${result.notes} (the run itself ended ${current.conclusion})`.trim();
    }
    return { repo, runUrl: current.html_url, conclusion: current.conclusion, result };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Sends one mail through the sctg-mail CLI (gog first, then the SMTP and Cloudflare fallbacks). */
export function sendMail({ cli, to, account, mail }, spawnFn = spawn) {
  return new Promise((resolve) => {
    const args = [cli, "send", "--to", to, "--subject", mail.subject, "--text-file", "-"];
    if (account) args.push("--account", account);
    const child = spawnFn(process.execPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ ok: false, detail: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, detail: clip(stderr, 300) }));
    child.stdin.end(mail.text);
  });
}

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    if (["skip-up-to-date", "dry-mail"].includes(key)) out.flags.add(key);
    else out.values[key] = argv[(i += 1)];
  }
  return out;
}

export async function main(argv, env, deps = {}) {
  const args = parseArgs(argv);
  const log = deps.log ?? ((m) => console.error(`fork-sync-watch: ${m}`));
  const to = args.values.to;
  const mode = args.values.mode ?? "sync";
  const anyToken = Object.keys(env).some((k) => k.startsWith("FORK_SYNC_GH_TOKEN") && env[k]);
  if (!anyToken || !to || !["sync", "dry-run"].includes(mode)) {
    log("usage: --to <recipient> [--account <sender>] [--mode sync|dry-run] [--repos a/b,c/d]; needs FORK_SYNC_GH_TOKEN (or FORK_SYNC_GH_TOKEN_<OWNER>)");
    return 2;
  }
  const { repos, rejected } = parseRepos(args.values.repos ?? env.FORK_SYNC_REPOS);
  if (rejected.length) log(`ignored invalid repository name(s): ${rejected.join(", ")}`);
  if (repos.length === 0) {
    log("no repository to sync");
    return 2;
  }
  const doFetch = deps.fetch ?? fetch;
  // A repo without a usable token is reported in its own mail instead of aborting the others.
  const ghFor = (repo) => {
    if (deps.gh) return deps.gh;
    const token = tokenFor(repo, env);
    return token ? github(token, doFetch) : undefined;
  };
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const timeoutMs = (Number(args.values["timeout-min"]) || 180) * 60_000;
  const send = deps.sendMail ?? ((m) => sendMail({ cli: env.SCTG_MAIL_CLI || "/opt/sctg-mail/dist/cli.js", to, account: args.values.account, mail: m }));

  // One mail per sync, sent as soon as that sync ends, so a slow fork never delays the others' report.
  const undelivered = [];
  await Promise.all(
    repos.map(async (repo) => {
      const gh = ghFor(repo);
      const outcome = gh
        ? await syncOne(repo, { mode, timeoutMs, pollMs: deps.pollMs ?? 30_000 }, { gh, sleep, now })
        : { repo, error: `no GitHub token for ${repo.split("/")[0]}: set FORK_SYNC_GH_TOKEN_${repo.split("/")[0].toUpperCase().replace(/[^A-Z0-9]/g, "_")}` };
      log(`${repo}: ${outcome.error ? `error: ${outcome.error}` : outcome.result.status}`);
      if (!outcome.error && args.flags.has("skip-up-to-date") && ["up-to-date", "skipped"].includes(outcome.result.status)) {
        return;
      }
      const mail = buildMail(outcome);
      if (args.flags.has("dry-mail")) {
        console.log(`--- ${mail.subject}\n${mail.text}\n`);
        return;
      }
      const sent = await send(mail);
      if (!sent.ok) {
        undelivered.push(repo);
        log(`${repo}: mail NOT delivered: ${sent.detail}`);
      }
    }),
  );
  return undelivered.length ? 3 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
