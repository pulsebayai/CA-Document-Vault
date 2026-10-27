import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  // Playwright empties outputDir at start. Keep it in its own sub-folder so it never deletes the
  // Unit/RLS JUnit files that earlier steps wrote to test-results/ (evidence bug, 2026-09-26).
  outputDir: "test-results/playwright",
  fullyParallel: false, // shared dev database — keep runs serial
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["junit", { outputFile: "test-results/junit-e2e.xml" }], ["json", { outputFile: "test-results/e2e-results.json" }]]
    : "list",
  // CI runners are in the US and the dev database is in Mumbai: allow for round-trips.
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", actionTimeout: 15_000, navigationTimeout: 30_000 },
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
