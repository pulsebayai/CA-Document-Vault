import { createHash } from "node:crypto";
import { adminClient } from "../../support/db";

// Feature 18 (spec X5) — before/after proof that nothing of Firm B changed, and small result helpers.


/** Every row of every office_id table of one office, hashed per table (service role). */
export async function snapshot(office: string, tables: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // the firm's own office row too (review I-2: name, branch, test clock — run_expected_generation is a definer)
  const { data: officeRow, error: oe } = await adminClient().from("office").select("*").eq("id", office).single();
  if (oe) throw new Error(`snapshot office: ${oe.message}`);
  out.office = createHash("sha256").update(JSON.stringify(officeRow)).digest("hex").slice(0, 16);
  for (const t of tables) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await adminClient().from(t).select("*").eq("office_id", office).range(from, from + 999);
      if (error) throw new Error(`snapshot ${t}: ${error.message}`);
      rows.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const sorted = rows.map((r) => JSON.stringify(r)).sort();
    out[t] = `${sorted.length}:${createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16)}`;
  }
  return out;
}

/** Tables whose hash differs between two snapshots. */
export const changedTables = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before).filter((t) => before[t] !== after[t]);

export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every((x) => isEmpty(x) || x === 0 || x === false);
  return false;
}

/** True when any of the needles appears anywhere in the JSON of the value. */
export const mentions = (value: unknown, needles: string[]) => {
  const text = JSON.stringify(value ?? null);
  return needles.filter((n) => text.includes(n));
};
