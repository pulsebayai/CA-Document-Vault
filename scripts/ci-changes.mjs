#!/usr/bin/env node
// Chore ci-docs-only (Raja 2026-09-30): decide whether a CI run needs the test jobs.
// Docs-only = every changed file is under sdlc/ or is a Markdown file. Anything else — code, tests, migrations,
// workflows, scripts, package files, config — needs the full suite. When in doubt (no base commit, git error,
// empty diff) the answer is "code", so a run is never skipped by mistake.
//
// Chore test-feedback (Raja 2026-10-06): also lists the PR's new or changed test files per suite, so CI runs them
// first and a failing new test stops the run in minutes, before the full suite.
//
// Usage in CI: BASE=<sha> HEAD=<sha> node scripts/ci-changes.mjs
//   → writes code=true|false, unit_tests, db_tests, e2e_tests (space-separated paths) to $GITHUB_OUTPUT
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

/** True when the path is documentation that no test depends on. */
export function isDocsPath(path) {
  return path.startsWith("sdlc/") || /\.md$/i.test(path);
}

/** "code" unless there is at least one changed file and every one is docs. */
export function classify(files) {
  const changed = files.map((f) => f.trim()).filter(Boolean);
  if (changed.length === 0) return "code";
  return changed.every(isDocsPath) ? "docs" : "code";
}

const SAFE = /^[A-Za-z0-9._/-]+$/; // paths go into a shell command line
const SUITES = { unit: /^tests\/unit\/[^/]+\.test\.tsx?$/, db: /^tests\/rls\/[^/]+\.test\.ts$/, e2e: /^tests\/e2e\/[^/]+\.spec\.ts$/ };

/** The changed test files of each suite (helpers and other code are covered by the full suite). */
export function changedTests(files) {
  const out = { unit: [], db: [], e2e: [] };
  for (const f of files.map((x) => x.trim()).filter((x) => SAFE.test(x))) {
    for (const [suite, re] of Object.entries(SUITES)) if (re.test(f)) out[suite].push(f);
  }
  return out;
}

function changedFiles(base, head) {
  if (!base || /^0+$/.test(base) || !head) return null; // new branch or unknown base
  try {
    // Three dots: what the head adds since it left the base (a PR's own changes).
    return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" }).split("\n");
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = changedFiles(process.env.BASE, process.env.HEAD);
  const kind = files ? classify(files) : "code";
  const code = kind === "code";
  // Deleted files can't be run; only files present in this checkout are listed.
  const tests = changedTests((files ?? []).filter((f) => f.trim() && existsSync(f.trim())));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `code=${code}\nunit_tests=${tests.unit.join(" ")}\ndb_tests=${tests.db.join(" ")}\ne2e_tests=${tests.e2e.join(" ")}\n`);
  }
  const note = code
    ? `Code changed — full suite runs.`
    : `Docs-only change (${files.filter(Boolean).length} file(s) under sdlc/ or *.md) — test jobs skipped. Not release evidence.`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`);
  console.log(note);
}
