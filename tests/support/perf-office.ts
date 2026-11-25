import { adminClient } from "./db";
import { createCatalogueOffice, resetTestOffice } from "./catalogue";
import { testOfficeName } from "./test-data";

// Chore test-volume (step 3) — the perf offices are seeded once and reused, like 15's K4 office, so a hosted run no
// longer rewrites ~1,000 clients per perf block. The office (lane-suffixed through testOfficeName) is reset only when
// it is new, or when its data isn't exactly what the block seeds (a reset then a fresh seed, never a second seed on
// top). The timed calls in these blocks are read-only, so a reused office stays as seeded. On CI's throwaway local
// stack every run is a new office, so it seeds every time.

export async function clientCount(officeId: string, filter?: { incharge_id: string }): Promise<number> {
  let q = adminClient().from("client").select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (filter) q = q.eq("incharge_id", filter.incharge_id);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

/**
 * Get a perf office ready: the office (reset only when new), its staff (get-or-create, so the same IDs on reuse), and
 * its seed data. `seed` runs only when the office doesn't hold exactly `clients` clients or `isComplete` says the seed
 * is partial; a non-new office is reset first, so the seed always starts from an empty office.
 */
export async function seededOffice<S>(label: string, opts: {
  clients: number;
  staff: (officeId: string) => Promise<S>;
  seed: (officeId: string, staff: S) => Promise<void>;
  isComplete?: (officeId: string, staff: S) => Promise<boolean>;
}): Promise<{ officeId: string; staff: S; seeded: boolean }> {
  const { data: found, error } = await adminClient().from("office").select("id").eq("name", testOfficeName(label)).maybeSingle();
  if (error) throw error;
  const isNew = !found;
  const officeId = await createCatalogueOffice(label, { reset: isNew });
  const staff = await opts.staff(officeId);
  const complete = !isNew
    && (await clientCount(officeId)) === opts.clients
    && (opts.isComplete ? await opts.isComplete(officeId, staff) : true);
  if (complete) return { officeId, staff, seeded: false };
  if (!isNew) await resetTestOffice(officeId);
  await opts.seed(officeId, staff);
  return { officeId, staff, seeded: true };
}
