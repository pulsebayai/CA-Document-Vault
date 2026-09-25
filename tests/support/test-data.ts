// Every record a test creates in the shared dev database carries this tag,
// so cleanup can remove exactly what the run created (see plan.md, risks).
export const RUN_TAG = `e2e-${process.env.GITHUB_RUN_ID ?? "local"}-${Date.now().toString(36)}`;

export function testEmail(label: string): string {
  return `${RUN_TAG}-${label}@example.test`.toLowerCase();
}
