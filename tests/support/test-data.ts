// Test users live in fixed "e2e office …" offices and are reused across runs (reset at the start),
// so the shared dev database does not fill up. Only flows that must create a brand-new person
// (the invite test) use a unique, run-tagged address.
export const RUN_TAG = `e2e-${process.env.GITHUB_RUN_ID ?? "local"}-${Date.now().toString(36)}`;

/** Stable address for a reusable fixture user. */
export function testEmail(label: string): string {
  return `e2e-${label}@example.test`.toLowerCase();
}

/** Unique address for tests that must create a new person each run. */
export function uniqueTestEmail(label: string): string {
  return `${RUN_TAG}-${label}@example.test`.toLowerCase();
}
