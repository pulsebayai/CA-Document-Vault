// Evidence bug 2026-09-26: Playwright emptied test-results/ and deleted the Unit/RLS JUnit files,
// so nightly evidence showed only the E2E row. These tests keep that from recurring silently.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSummary } from "../../scripts/regression-summary.mjs";
import playwrightConfig from "../../playwright.config";

function resultsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const junit = (tests: number, failures = 0) =>
  `<?xml version="1.0"?><testsuites name="vitest tests" tests="${tests}" failures="${failures}" errors="0" time="1"></testsuites>`;
const e2e = JSON.stringify({ stats: { expected: 14, unexpected: 0, flaky: 0, skipped: 0 } });

describe("regression evidence summary", () => {
  it("reports every suite when all result files exist", () => {
    const dir = resultsDir({ "junit-unit.xml": junit(11), "junit-db.xml": junit(10), "e2e-results.json": e2e });
    const { markdown, missing } = buildSummary({ dir, expect: ["unit", "db", "e2e"] });
    expect(missing).toEqual([]);
    expect(markdown).toContain("| Unit | 11 | 0 | 0 |");
    expect(markdown).toContain("| RLS (DB security) | 10 | 0 | 0 |");
    expect(markdown).toContain("| E2E / smoke | 14 | 0 | 0 |");
  });

  it("flags an expected suite whose result file is missing", () => {
    const dir = resultsDir({ "e2e-results.json": e2e });
    const { markdown, missing } = buildSummary({ dir, expect: ["unit", "db", "e2e"] });
    expect(missing).toEqual(["unit", "db"]);
    expect(markdown).toContain("Evidence incomplete");
  });

  it("counts failures and errors from JUnit", () => {
    const dir = resultsDir({ "junit-db.xml": junit(10, 2) });
    expect(buildSummary({ dir, expect: ["db"] }).markdown).toContain("| RLS (DB security) | 8 | 2 | 0 |");
  });

  it("Playwright's outputDir is not the shared test-results/ folder it would empty", () => {
    const out = resolve(playwrightConfig.outputDir ?? "test-results");
    expect(out).not.toBe(resolve("test-results"));
  });
});
