import { describe, expect, it } from "vitest";
import { classify, isDocsPath } from "../../scripts/ci-changes.mjs";

// Chore ci-docs-only: docs-only PRs and pushes skip the test jobs; anything else runs the full suite.
describe("CI change classifier", () => {
  it("treats sdlc/ files and Markdown anywhere as docs", () => {
    expect(isDocsPath("sdlc/product/roadmap.md")).toBe(true);
    expect(isDocsPath("sdlc/releases/R1/evidence/summary.txt")).toBe(true);
    expect(isDocsPath("CLAUDE.md")).toBe(true);
    expect(isDocsPath("REVIEW.md")).toBe(true);
  });

  it("treats code, tests, migrations, workflows, scripts and config as code", () => {
    for (const p of [
      "src/app/page.tsx", "tests/rls/plan.test.ts", "supabase/migrations/20260930120000_expected_docs.sql",
      ".github/workflows/ci.yml", "scripts/ci-changes.mjs", "package.json", "package-lock.json",
      "next.config.ts", ".claude/settings.json", "sdlc.config.json",
    ]) expect(isDocsPath(p), p).toBe(false);
  });

  it("is docs only when every changed file is docs", () => {
    expect(classify(["sdlc/product/roadmap.md", "sdlc/features/04-expected-docs-schedule/plan.md"])).toBe("docs");
    expect(classify(["sdlc/product/roadmap.md", "src/lib/expected/schedule.ts"])).toBe("code");
    expect(classify(["CLAUDE.md", ".github/workflows/ci.yml"])).toBe("code");
  });

  it("fails safe: no changed files means run everything", () => {
    expect(classify([])).toBe("code");
    expect(classify(["", "  "])).toBe("code");
  });
});
