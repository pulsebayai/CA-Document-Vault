// Writes a Markdown evidence summary from JUnit/Playwright result files (used by CI and release records).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const rows = [];
function junit(file, suite) {
  if (!existsSync(file)) return;
  const xml = readFileSync(file, "utf8");
  const m = xml.match(/<testsuites[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"[^>]*/) ?? [];
  const skipped = (xml.match(/<skipped/g) ?? []).length;
  const total = Number(m[1] ?? 0), failed = Number(m[2] ?? 0) + Number(m[3] ?? 0);
  rows.push([suite, total - failed - skipped, failed, skipped]);
}
junit("test-results/junit-unit.xml", "Unit");
junit("test-results/junit-db.xml", "RLS (DB security)");
if (existsSync("test-results/e2e-results.json")) {
  const s = JSON.parse(readFileSync("test-results/e2e-results.json", "utf8")).stats ?? {};
  rows.push(["E2E / smoke", s.expected ?? 0, s.unexpected ?? 0, s.skipped ?? 0]);
}
const env = process.env.TARGET ?? "ci";
const run = process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "local";
const out = [
  `## Regression evidence — ${env}`,
  `Commit: \`${process.env.GITHUB_SHA ?? "local"}\` · Target: ${process.env.E2E_BASE_URL ?? "localhost"} · Run: ${run} · Date (UTC): ${new Date().toISOString()}`,
  "",
  "| Suite | Passed | Failed | Skipped |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.join(" | ")} |`),
  "",
].join("\n");
mkdirSync("test-results", { recursive: true });
writeFileSync("test-results/summary.md", out);
process.stdout.write(out);
