#!/usr/bin/env node
// Fails the build when files that ship in the PUBLIC sctg/claw image contain something that must not
// be public: secret-shaped strings, private IPv4 addresses, or e-mail addresses that are not
// placeholders. Scans exactly what the Dockerfile copies from the named contexts that this repo or
// the private k8s-infra repo provide. Lives in .github/ so it is never shipped itself.
//
// Usage: node .github/scripts/check-public-content.mjs [dir ...]   (defaults below)
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_ROOTS = ["scripts", "k8s-infra/openclaw-plugin"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const MAX_BYTES = 1024 * 1024;

// Domains that are placeholders in docs and test fixtures, not real mailboxes.
const PLACEHOLDER_EMAIL = /@(example\.(org|com|net)|x\.org|y\.org|z\.org|users\.noreply\.github\.com)$|^noreply@|^git@github\.com$/i;

const SECRET_RULES = [
  ["anthropic-token", /sk-ant-[A-Za-z0-9_-]{8,}/],
  ["age-secret-key", /AGE-SECRET-KEY-[A-Z0-9]{10,}/],
  ["private-key-block", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["github-token", /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function isPrivateIpv4(a, b) {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Pure: findings for one file's text. Secret matches are never echoed back, only named. */
export function scanText(text, file) {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    for (const [rule, re] of SECRET_RULES) {
      if (re.test(line)) {
        findings.push({ at, rule, detail: "(value hidden)" });
      }
    }
    for (const m of line.matchAll(EMAIL)) {
      if (!PLACEHOLDER_EMAIL.test(m[0])) {
        findings.push({ at, rule: "email", detail: m[0] });
      }
    }
    for (const m of line.matchAll(IPV4)) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (isPrivateIpv4(a, b)) {
        findings.push({ at, rule: "private-ipv4", detail: m[0] });
      }
    }
  });
  return findings;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) {
        yield* walk(full);
      }
    } else if (st.isFile() && !SKIP_FILES.has(name) && st.size <= MAX_BYTES) {
      yield full;
    }
  }
}

function main() {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS;
  const findings = [];
  let scanned = 0;
  for (const root of roots) {
    let exists = true;
    try {
      statSync(root);
    } catch {
      exists = false;
    }
    if (!exists) {
      // A missing root would silently weaken the guard (e.g. the private submodule failed to check out).
      console.error(`public-content guard: scan root not found: ${root}`);
      process.exit(2);
    }
    for (const file of walk(root)) {
      const buf = readFileSync(file);
      if (buf.includes(0)) {
        continue; // binary
      }
      scanned += 1;
      findings.push(...scanText(buf.toString("utf8"), file));
    }
  }
  if (findings.length > 0) {
    console.error(`public-content guard: ${findings.length} problem(s) in files that ship in the public image:`);
    for (const f of findings) {
      console.error(`  ${f.at}  [${f.rule}]  ${f.detail}`);
    }
    console.error("Use a placeholder (e.g. user@example.org) or move the value into operator-side configuration.");
    process.exit(1);
  }
  console.log(`public-content guard: ${scanned} files scanned in ${roots.join(", ")}, nothing to report`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
