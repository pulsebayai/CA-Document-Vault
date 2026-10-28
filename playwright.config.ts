import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// The local stack's self-signed cert is accepted only for a local build; never for a deployed (hosted) target.
if (process.env.E2E_LOCAL_DB === "1" && process.env.E2E_BASE_URL) {
  throw new Error("E2E_LOCAL_DB=1 is for CI's own build against a local Supabase; unset it when E2E_BASE_URL is set.");
}

export default defineConfig({
  testDir: "tests/e2e",
  // Playwright empties outputDir at start. Keep it in its own sub-folder so it never deletes the
  // Unit/RLS JUnit files that earlier steps wrote to test-results/ (evidence bug, 2026-09-26).
  outputDir: "test-results/playwright",
  fullyParallel: false, // hosted runs share the dev database — keep runs serial (PR CI shards instead: ci.yml)
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ["github"], ["html", { open: "never" }], ["junit", { outputFile: "test-results/junit-e2e.xml" }], ["json", { outputFile: "test-results/e2e-results.json" }],
        // Sharded PR CI (chore ci-speed): each shard also writes a blob that `e2e (all shards)` merges into one report.
        ...(process.env.E2E_SHARD ? [["blob", { outputDir: "blob-report", fileName: `report-${process.env.E2E_SHARD}.zip` }] as const] : []),
      ]
    : "list",
  // Hosted runs: CI runners are in the US and the dev database is in Mumbai: allow for round-trips.
  expect: { timeout: 15_000 },
  use: {
    baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", actionTimeout: 15_000, navigationTimeout: 30_000,
    // E2E_LOCAL_DB=1 (CI, chore ci-speed step 3): the app talks to an ephemeral local Supabase whose API uses a
    // self-signed cert (scripts/local-db.sh). The browser opens its sign-in links and Storage URLs directly, so it
    // must accept that cert. Never set for hosted targets (dev, staging, prod).
    ignoreHTTPSErrors: process.env.E2E_LOCAL_DB === "1",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // E2E_PREBUILT=1 (CI only, chore ci-speed): the job ran `npm run build` once, so each Playwright run only starts it.
        // Never set it locally: a stale .next build would be tested.
        command: process.env.E2E_PREBUILT === "1" ? `npm run start -- -p ${PORT}` : `npm run build && npm run start -- -p ${PORT}`,
        url: baseURL,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
      },
});
