import { test as base } from "@playwright/test";
import { allowPreview } from "./preview-access";

/**
 * The `test` every e2e spec uses. Adds one automatic step: when the run targets a protected Vercel preview,
 * the test's browser context gets the bypass cookie before the test starts (see preview-access.ts).
 * Contexts a test creates itself get it in signIn().
 */
export const test = base.extend<{ previewAccess: void }>({
  previewAccess: [
    async ({ context, baseURL }, use) => {
      await allowPreview(context, baseURL);
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
export type { Page, Locator, BrowserContext } from "@playwright/test";
