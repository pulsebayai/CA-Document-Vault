// Test users live in fixed "e2e office …" offices and are reused across runs (reset at the start),
// so the shared dev database does not fill up. Only flows that must create a brand-new person
// (the invite test) use a unique, run-tagged address.
//
// Lanes (chore test-isolation, 2026-09-29): up to two CI/Regression runs share the dev database at once.
// Each leases a lane (scripts/test-lane.mjs → TEST_LANE=1..9) and gets its own copy of every fixture office
// and user, so runs never reset each other's data. Without TEST_LANE (a developer's machine or a Claude
// session) the lane is "local" and the names are exactly the pre-lane ones.
export const RUN_TAG = `e2e-${process.env.GITHUB_RUN_ID ?? "local"}-${Date.now().toString(36)}`;

/** Fixture names for one lane. Pure, so the naming rule is unit-tested without touching the environment. */
export function fixtureNames(lane: string) {
  if (!/^(local|[1-9])$/.test(lane)) throw new Error(`TEST_LANE must be 1–9 or "local", got "${lane}"`);
  const local = lane === "local";
  return {
    lane,
    email: (label: string) => `e2e-${label}${local ? "" : `-l${lane}`}@example.test`.toLowerCase(),
    office: (label: string) => `e2e office ${label}${local ? "" : ` #${lane}`}`,
  };
}

const names = fixtureNames(process.env.TEST_LANE?.trim() || "local");
export const TEST_LANE = names.lane;

/** Stable address for a reusable fixture user (per lane). */
export function testEmail(label: string): string {
  return names.email(label);
}

/** Name of a reusable fixture office (per lane). Names starting "e2e office " are test offices. */
export function testOfficeName(label: string): string {
  return names.office(label);
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
