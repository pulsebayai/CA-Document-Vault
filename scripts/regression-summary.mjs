// Writes a Markdown evidence summary from JUnit/Playwright result files (used by CI and release records).
// EXPECT_SUITES (comma list of unit, db, e2e) names the suites this job ran. A named suite whose result
// file is missing is reported as MISSING and the script exits 1, so evidence can never be silently incomplete.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SUITES = {
  unit: { label: "Unit", file: "junit-unit.xml", kind: "junit" },
  db: { label: "RLS (DB security)", file: "junit-db.xml", kind: "junit" },
  e2e: { label: "E2E / smoke", file: "e2e-results.json", kind: "playwright" },
};

function readJunit(path) {
  const xml = readFileSync(path, "utf8");
  const tag = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? "";
  const attr = (name) => Number(tag.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0);
  const skipped = (xml.match(/<skipped/g) ?? []).length;
  const failed = attr("failures") + attr("errors");
  return { passed: attr("tests") - failed - skipped, failed, skipped };
}

function readPlaywright(path) {
  const s = JSON.parse(readFileSync(path, "utf8")).stats ?? {};
  return { passed: s.expected ?? 0, failed: (s.unexpected ?? 0) + (s.flaky ?? 0), skipped: s.skipped ?? 0 };
}

/**
 * Builds the summary. Returns { markdown, missing } — missing lists expected suites without results.
 * @param {{ dir?: string, expect?: string[], env?: Record<string, string | undefined> }} [options]
 */
export function buildSummary({ dir = "test-results", expect = [], env = {} } = {}) {
  const rows = [];
  const missing = [];
  for (const [key, suite] of Object.entries(SUITES)) {
    const path = join(dir, suite.file);
    if (existsSync(path)) {
      const r = suite.kind === "junit" ? readJunit(path) : readPlaywright(path);
      rows.push([suite.label, r.passed, r.failed, r.skipped]);
    } else if (expect.includes(key)) {
      missing.push(key);
      rows.push([suite.label, "MISSING", "MISSING", "MISSING"]);
    }
  }
  const run = env.GITHUB_SERVER_URL
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : "local";
  const markdown = [
    `## Regression evidence — ${env.TARGET ?? "ci"}`,
    ...(env.ONLY ? [`**Quick check — only: \`${env.ONLY}\`. Partial run; not release evidence.**`] : []),
    `Commit: \`${env.GITHUB_SHA ?? "local"}\` · Target: ${env.E2E_BASE_URL ?? "localhost"} · Run: ${run} · Date (UTC): ${new Date().toISOString()}`,
    "",
    "| Suite | Passed | Failed | Skipped |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    ...(missing.length ? [`**Evidence incomplete — no result file for: ${missing.join(", ")}**`, ""] : []),
  ].join("\n");
  return { markdown, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const expect = (process.env.EXPECT_SUITES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const { markdown, missing } = buildSummary({ expect, env: process.env });
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/summary.md", markdown);
  process.stdout.write(markdown);
  if (missing.length) {
    process.stderr.write(`::error::Evidence incomplete: no result file for ${missing.join(", ")}\n`);
    process.exit(1);
  }
}
