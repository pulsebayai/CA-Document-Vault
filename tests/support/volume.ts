import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, signedInClient } from "./db";
import { groupId, resetTestOffice } from "./catalogue";
import { BUCKET, TINY, purgeTestStorage } from "./documents";
import { testGstin, testPan, testTan } from "./test-data";

// 09 volume test (chore, R1 gate). One persistent office at pilot volume, shared by every lane and by local runs:
// it is seeded once and only re-seeded when its row counts are wrong (or VOLUME_RESEED=1). Volume runs are
// serialised by the `volume` concurrency group in regression.yml; a local run must not overlap one.
// Everything is written as a signed-in user through the app's functions (02: the service role can't write clients);
// the service role only reads, uploads the tiny synthetic files and resets the office.

export const VOLUME_OFFICE = "e2e office volume";
export const VOLUME = {
  clients: 1000,
  staffClients: 150, // incharge = the Staff user (06 AC-6: Today with ~150 clients)
  limitedClients: 50, // incharge = the Limited user (03b/08 Limited timings)
  documents: 10_000, // filed documents, all linked to an expected item (Raja 2026-09-29)
  inbox: 100,
  softShare: 0.7, // soft copies get a real 1-byte-ish storage object (file-name search, zip lists)
  reviewedShare: 0.3,
  activity: 200_000, // ≈ a year (08 spec)
  minExpected: 170_000, // 04 spec ≈ 180k; spike: 183 per client
} as const;

/** Six groups ≈ 183 expected items per client over a year (spike 2026-10-07). */
export const VOLUME_GROUPS = ["GST", "TDS/TCS", "Banking", "Payroll", "Income Tax", "Accounting"] as const;
export const CLOCK_START = "2026-04-02"; // clients are created here, so their plans start in April 2026
export const CLOCK_END = "2027-04-15"; // twelve months of items have reached their ask date

const IMPORT_CHUNK = 40; // 6 groups: ≈ 3.4 s per chunk (K1: 200 rows take 16.9 s, over the 8 s statement timeout)
const DOC_CHUNK = 250; // create_document ≈ 3.8 ms (hard copy) — soft copies + linking cost more
const UPLOAD_PARALLEL = 16;
const REVIEW_CHUNK = 200; // review_documents' own limit
const ACTIVITY_CHUNK = 20_000; // seed_test_activity's cap

type Role = "admin" | "manager" | "staff" | "limited";
const ROLES: Role[] = ["admin", "manager", "staff", "limited"];
export type VolumeUser = { id: string; email: string };
export type VolumeCtx = {
  officeId: string;
  users: Record<Role, VolumeUser>;
  as: Record<Role, SupabaseClient>;
  /** A Staff-incharge client with the most documents (Client › Documents / Expected / activity filter). */
  busyClientId: string;
  /** A document with the most activity rows (document Activity card). */
  busyDocumentId: string;
  /** Present only when this run seeded documents/activity (part C): step timings. */
  seed?: SeedLog;
};
export type SeedLog = { totalMs: number; uploadMs: number; documentsMs: number; reviewMs: number; activityMs: number };

export const GENERATE_NEEDED = "VOLUME_GENERATE_NEEDED";
export const volumeEmail = (role: Role) => `e2e-volume-${role}@example.test`;

const sb = () => adminClient();
const count = async (table: string, officeId: string, f?: (q: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  let q = sb().from(table).select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (f) q = f(q);
  const { count: n, error } = await q;
  if (error) throw error;
  return n ?? 0;
};

export async function volumeCounts(officeId: string) {
  const [clients, expected, filed, inbox, versions, activity] = await Promise.all([
    count("client", officeId),
    count("expected_doc", officeId),
    count("document", officeId, (q) => q.not("classified_at", "is", null)),
    count("document", officeId, (q) => q.is("client_id", null)),
    count("document_version", officeId),
    count("activity", officeId),
  ]);
  return { clients, expected, filed, inbox, versions, activity };
}

export function countsOk(c: Awaited<ReturnType<typeof volumeCounts>>) {
  return c.clients >= VOLUME.clients && c.expected >= VOLUME.minExpected && c.filed >= VOLUME.documents
    && c.inbox >= VOLUME.inbox && c.versions >= Math.floor(VOLUME.documents * VOLUME.softShare) && c.activity >= VOLUME.activity;
}

async function officeId(): Promise<string> {
  const { data, error } = await sb().from("office").select("id, is_test").eq("name", VOLUME_OFFICE).maybeSingle();
  if (error) throw error;
  if (data) {
    if (!data.is_test) throw new Error(`${VOLUME_OFFICE} is not flagged is_test — refusing to use it`);
    return data.id as string;
  }
  const { data: made, error: e2 } = await sb().from("office").insert({ name: VOLUME_OFFICE, branch: "test", is_test: true }).select("id").single();
  if (e2) throw e2;
  await resetTestOffice(made.id as string); // seeds the catalogue and financial years
  return made.id as string;
}

const must = async <T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> => {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};
const ms = (t0: number) => Math.round(performance.now() - t0);

/** Get the volume office, seeding it first when its counts are wrong. Logs counts (and seed timings when seeded). */
export async function volumeOffice(): Promise<VolumeCtx> {
  const id = await officeId();
  const users = {} as Record<Role, VolumeUser>;
  for (const r of ROLES) users[r] = await createStaff(id, `volume-${r}`, r, "active", volumeEmail(r));
  const as = {} as Record<Role, SupabaseClient>;
  for (const r of ROLES) as[r] = await signedInClient(users[r].email);

  let seed: SeedLog | undefined;
  const before = await volumeCounts(id);
  console.log("volume: counts before", JSON.stringify(before));
  if (process.env.VOLUME_RESEED === "1" || (before.clients > 0 && before.clients < VOLUME.clients)) {
    // At volume, reset_test_office runs past the API's 8 s statement timeout (local run 2026-10-07), so a reseed
    // starts with part 0 in SQL: scripts/volume-generate.sql.
    throw new Error(`${GENERATE_NEEDED} — reset the office first (scripts/volume-generate.sql, part 0), then re-run with VOLUME=1`);
  } else if (before.clients === 0) {
    await reseed(id, users, as); // part A, then stops: part B is SQL
  } else if (before.expected < VOLUME.minExpected) {
    throw new Error(`${GENERATE_NEEDED} — ${before.expected} expected items; run scripts/volume-generate.sql, then re-run with VOLUME=1`);
  } else if (!countsOk(before)) {
    seed = await seedDocuments(id, as);
  }
  const after = await volumeCounts(id);
  console.log("volume: counts", JSON.stringify(after));
  if (!countsOk(after)) throw new Error(`volume office counts still short after seeding: ${JSON.stringify(after)}`);

  const busy = await must(sb().from("document").select("client_id, client:client_id!inner(incharge_id)")
    .eq("office_id", id).eq("client.incharge_id", users.staff.id).not("client_id", "is", null).limit(1000), "busy client");
  const perClient = new Map<string, number>();
  for (const d of busy as Array<{ client_id: string }>) perClient.set(d.client_id, (perClient.get(d.client_id) ?? 0) + 1);
  const busyClientId = [...perClient.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const doc = await must(sb().from("activity").select("entity_id").eq("office_id", id).eq("entity_type", "document")
    .eq("action", "document.reviewed").limit(1).maybeSingle(), "busy document");
  const busyDocumentId = (doc as { entity_id: string } | null)?.entity_id
    ?? ((await must(sb().from("document").select("id").eq("office_id", id).not("client_id", "is", null).limit(1).single(), "a document")) as { id: string }).id;
  return { officeId: id, users, as, busyClientId, busyDocumentId, seed };
}

/** Part A (API), on an empty office (new, or reset by part 0): storage purged, clients imported; then stops for part B. */
async function reseed(id: string, users: Record<Role, VolumeUser>, as: Record<Role, SupabaseClient>): Promise<never> {
  await purgeTestStorage(id);
  const admin = as.admin;

  // 1. Clients on the start clock (part A, API): 150 Staff, 50 Limited, the rest Manager as incharge; GSTIN + TAN;
  // six groups; ≤ 40 rows per call (K1). Import-time generation is client-scoped, so it stays fast at any office size.
  await must(admin.rpc("run_expected_generation", { p_as_of: CLOCK_START }), "start clock");
  const groups = await Promise.all(VOLUME_GROUPS.map((g) => groupId(id, g)));
  const incharge = (i: number) => (i < VOLUME.staffClients ? users.staff.id
    : i < VOLUME.staffClients + VOLUME.limitedClients ? users.limited.id : users.manager.id);
  const rows = Array.from({ length: VOLUME.clients }, (_, i) => {
    const pan = testPan("P", 6000 + i);
    return { name: `Volume client ${String(i).padStart(4, "0")}`, client_type: "proprietorship", pan, incharge_id: incharge(i),
      registrations: [{ kind: "gstin", number: testGstin(pan) }, { kind: "tan", number: testTan(60000 + i) }], group_ids: groups };
  });
  const t = performance.now();
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
    await must(admin.rpc("import_clients", { p_rows: rows.slice(i, i + IMPORT_CHUNK) }), `import chunk ${i / IMPORT_CHUNK}`);
  }
  const importMs = ms(t);
  // 2. A year of expected items (part B) can't go through the API: the office-wide daily job takes longer than the
  // 8 s statement timeout at this size (5.5 s with nothing to create at 400 clients, local run 2026-10-07). It runs
  // as the database owner, like pg_cron: scripts/volume-generate.sql (Supabase connector or SQL editor).
  throw new Error(`${GENERATE_NEEDED} — clients imported in ${importMs} ms; now run scripts/volume-generate.sql, then re-run with VOLUME=1`);
}

/** Part C (API): documents, reviews and activity, once the year of expected items exists. */
async function seedDocuments(id: string, as: Record<Role, SupabaseClient>): Promise<SeedLog> {
  const t0 = performance.now();
  const admin = as.admin;
  let t = performance.now();

  // 3. Documents: one per sampled expected item (so every filed document links), 70 % soft copies with a file.
  const items: Array<{ client_id: string; doc_type_id: string; period_id: string; registration_id: string | null; type: { name: string }; period: { code: string } }> = [];
  for (let from = 0; ; from += 1000) {
    const page = await must(sb().from("expected_doc").select("client_id, doc_type_id, period_id, registration_id, type:doc_type_id(name), period:period_id(code)")
      .eq("office_id", id).order("id").range(from, from + 999), "expected page") as unknown as typeof items;
    items.push(...page);
    if (page.length < 1000) break;
  }
  const step = Math.max(1, Math.floor(items.length / VOLUME.documents));
  const picked = items.filter((_, i) => i % step === 0).slice(0, VOLUME.documents);
  const channels = ["whatsapp", "email", "hand_delivery", "courier", "portal", "other"];
  const payloads: Array<Record<string, unknown>> = picked.map((e, i) => ({
    client_id: e.client_id, doc_type_id: e.doc_type_id, period_id: e.period_id, registration_id: e.registration_id,
    received_as: i % 10 < 7 ? "soft_copy" : i % 2 ? "hard_copy" : "original", channel: channels[i % channels.length],
    ...(i % 5 === 0 ? { remark: `Batch ${i % 50} received with covering note` } : {}),
    _file: i % 10 < 7 ? `${e.type.name.replace(/[\\/]/g, "-")} ${e.period.code}.pdf` : null,
  }));
  t = performance.now();
  const store = sb().storage.from(BUCKET);
  const soft = payloads.filter((p) => p._file);
  for (let i = 0; i < soft.length; i += UPLOAD_PARALLEL) {
    await Promise.all(soft.slice(i, i + UPLOAD_PARALLEL).map(async (p) => {
      const path = `office/${id}/doc/${randomUUID()}/${randomUUID()}.pdf`;
      const { error } = await store.upload(path, TINY.pdf.bytes, { contentType: TINY.pdf.mime, upsert: false });
      if (error) throw new Error(`upload: ${error.message}`);
      p.file = { storage_path: path, file_name: p._file };
    }));
  }
  const uploadMs = ms(t);
  for (const p of payloads) delete p._file;
  for (let i = 0; i < VOLUME.inbox; i++) payloads.push({ received_as: "hard_copy", channel: "whatsapp", remark: `Inbox volume item ${i}` });
  t = performance.now();
  for (let i = 0; i < payloads.length; i += DOC_CHUNK) {
    await must(admin.rpc("seed_test_documents", { p_docs: payloads.slice(i, i + DOC_CHUNK) }), `documents chunk ${i / DOC_CHUNK}`);
  }
  const documentsMs = ms(t);

  // 4. Review 30 % of the filed documents (07 state mix + activity), through 08's bulk function.
  const filedIds: string[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await must(sb().from("document").select("id").eq("office_id", id).not("classified_at", "is", null).order("id").range(from, from + 999), "documents page") as Array<{ id: string }>;
    filedIds.push(...page.map((d) => d.id));
    if (page.length < 1000) break;
  }
  const toReview = filedIds.filter((_, i) => i % 10 < VOLUME.reviewedShare * 10);
  t = performance.now();
  for (let i = 0; i < toReview.length; i += REVIEW_CHUNK) {
    await must(admin.rpc("review_documents", { p_ids: toReview.slice(i, i + REVIEW_CHUNK) }), `review chunk ${i / REVIEW_CHUNK}`);
  }
  const reviewMs = ms(t);

  // 5. Activity top-up to ≈ a year (copies of this office's real rows, spread over the year; test offices only).
  t = performance.now();
  for (let have = await count("activity", id); have < VOLUME.activity; have = await count("activity", id)) {
    await must(admin.rpc("seed_test_activity", { p_count: Math.min(ACTIVITY_CHUNK, VOLUME.activity - have),
      p_from: "2026-04-01T00:00:00+05:30", p_to: new Date().toISOString() }), "activity top-up");
  }
  const activityMs = ms(t);

  const log: SeedLog = { totalMs: ms(t0), uploadMs, documentsMs, reviewMs, activityMs };
  console.log("volume: seed", JSON.stringify(log));
  return log;
}

// ── Timing ────────────────────────────────────────────────────────────────────────────────────────────────────

export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

type Res = { error?: { message: string } | null } | Array<{ error?: { message: string } | null }> | unknown;
const TIMEOUT = /statement timeout/i;
/** The first error in a result (or array of results), if any. */
function errorOf(r: Res): string | null {
  for (const x of (Array.isArray(r) ? r : [r]) as Array<{ error?: { message: string } | null }>) if (x?.error) return x.error.message;
  return null;
}

/**
 * Median of 5 warm calls (one warm-up first), as PR #30 does for 02's clients list. A statement timeout (8 s,
 * `authenticated`) returns Infinity at once: the screen errors at this volume, which is recorded as a known issue
 * (Raja 2026-10-07: record, don't fix). Any other error throws.
 */
export async function timeIt(run: () => PromiseLike<Res>, n = 5): Promise<number> {
  const first = errorOf(await run());
  if (first && TIMEOUT.test(first)) return Infinity;
  if (first) throw new Error(first);
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const e = errorOf(await run());
    times.push(performance.now() - t0);
    if (e && TIMEOUT.test(e)) return Infinity;
    if (e) throw new Error(e);
  }
  return median(times);
}

/** The runner → Mumbai round trip for a trivial PostgREST read, to estimate server time (round trip − ping). */
export async function ping(as: SupabaseClient): Promise<number> {
  return timeIt(() => as.from("office").select("id").limit(1));
}

export type VolumeTiming = { id: string; what: string; targetMs: number; roundTripMs: number; serverMs: number; pass: boolean; note?: string };
export const timings: VolumeTiming[] = [];

/** Records one target (server ≈ round trip − ping, never below 0) for the evidence table; returns the server ms. */
export function record(id: string, what: string, targetMs: number, roundTripMs: number, pingMs: number, note?: string): VolumeTiming {
  if (!Number.isFinite(roundTripMs)) {
    const row = { id, what, targetMs, roundTripMs: -1, serverMs: -1, pass: false, note: `TIMEOUT: over the 8 s statement limit (the screen errors)${note ? `; ${note}` : ""}` };
    timings.push(row);
    console.log(`volume: ${id} ${what}: TIMEOUT (> 8 s) — target < ${targetMs} ms — MISSED`);
    return row;
  }
  const serverMs = Math.max(0, Math.round(roundTripMs - pingMs));
  const row = { id, what, targetMs, roundTripMs: Math.round(roundTripMs), serverMs, pass: serverMs < targetMs, ...(note ? { note } : {}) };
  timings.push(row);
  console.log(`volume: ${id} ${what}: server ≈ ${serverMs} ms (round trip ${row.roundTripMs} ms) — target < ${targetMs} ms — ${row.pass ? "PASS" : "MISSED"}`);
  return row;
}
