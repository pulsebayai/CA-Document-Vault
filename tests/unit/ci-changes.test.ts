import { describe, expect, it } from "vitest";
import { changedTests, classify, isDocsPath } from "../../scripts/ci-changes.mjs";

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

// Chore test-feedback (Raja 2026-10-06): CI runs a PR's new or changed test files first, so a new test that fails
// stops the run in minutes instead of after the full suite.
describe("changed test files, by suite", () => {
  it("picks unit, RLS and e2e test files; helpers, specs' support files and other code are not run on their own", () => {
    expect(changedTests([
      "tests/unit/proposal-queue.test.tsx", "tests/rls/type-governance.test.ts", "tests/rls/type-governance-perf.test.ts",
      "tests/e2e/type-governance.spec.ts", "tests/support/catalogue.ts", "tests/e2e/helpers.ts", "src/lib/catalogue/governance.ts",
      "sdlc/features/05-type-governance/plan.md",
    ])).toEqual({
      unit: ["tests/unit/proposal-queue.test.tsx"],
      db: ["tests/rls/type-governance.test.ts", "tests/rls/type-governance-perf.test.ts"],
      e2e: ["tests/e2e/type-governance.spec.ts"],
    });
  });

  it("ignores names that aren't plain paths (they are passed to a shell)", () => {
    expect(changedTests(["tests/rls/a b.test.ts", "tests/rls/$(x).test.ts", "tests/rls/ok-1.test.ts"]).db).toEqual(["tests/rls/ok-1.test.ts"]);
  });

  it("nothing changed → nothing to run first", () => {
    expect(changedTests([])).toEqual({ unit: [], db: [], e2e: [] });
  });
});
