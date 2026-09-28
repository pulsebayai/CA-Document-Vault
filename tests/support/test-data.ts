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

// ── Synthetic identifiers (spec NFR: never real PANs in fixtures) ─────────────
// Reserved pattern: PAN "ZZZ?Z9999Z", TAN "ZZZZ99999Z". Well-formed, obviously fake.
const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** PAN whose 4th letter is `typeLetter` (P, H, F, C, T, A, …). `n` 0–9999 keeps it unique within an office. */
export function testPan(typeLetter: string, n: number): string {
  return `ZZZ${typeLetter.toUpperCase()}Z${pad(n % 10000, 4)}Z`;
}

/** GSTIN for a PAN: 2-digit state + PAN + entity digit + "Z" + check char (format only; checksum not verified). */
export function testGstin(pan: string, stateCode = "33", entity = 1): string {
  return `${stateCode}${pan}${entity}Z5`;
}

/** TAN in the reserved pattern. */
export function testTan(n: number): string {
  return `ZZZZ${pad(n % 100000, 5)}Z`;
}

/** Period codes for "today" in India (FY starts in April; Q1 = Apr–Jun). */
export function currentPeriodCodes(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1;
  const fyStart = m >= 4 ? y : y - 1;
  const fy = `${fyStart}-${pad((fyStart + 1) % 100, 2)}`;
  const q = Math.floor(((m + 8) % 12) / 3) + 1;
  return { month: `${y}-${pad(m, 2)}`, quarter: `${fy}-Q${q}`, year: fy };
}
