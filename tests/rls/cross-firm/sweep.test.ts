import { appendFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "../../support/db";
import { uploadObject } from "../../support/documents";
import { inventory, type Inventory } from "./inventory";
import { rowCounts, seedEmptyFirm, seedTwoFirms, type Firm } from "./seed";
import { changedTables, isEmpty, mentions, snapshot } from "./helpers";
import { FN_CASES, shared, type FnCase } from "./functions";
import { PARENT, PARENT2, ROW } from "./rows";
import { FUNCTIONS, TABLES } from "./coverage";
import { PLATFORM_FUNCTIONS, createPlatformAdmin, signedInPlatformAdmin } from "../../support/platform";
import { signedInClient } from "../../support/db";

// Feature 18 — the cross-firm sweep (spec AC-1, AC-4–AC-13). Firm A's staff (Admin unless stated, spec X3) try every
// door into Firm B. One seed per run (≈ 2 min on dev from a session), so the sections share this file and run in order
// (later sections use Firm A state the earlier ones leave). Every refusal is paired with a **control** — the same call
// with the same payload shape on Firm A's own objects, which must succeed — so a case can't pass because of a bad
// argument (plan: "Proving a refusal is the tenant refusal"; pre-PR review I-4, I-6). afterAll proves Firm B is
// unchanged (snapshot incl. its office row) and that no Firm A row or activity points at Firm B (review I-1, I-2).

// Step 6 (AC-12 b): the app's own file-link code runs here as Firm A's signed-in Admin. Its Supabase client and
// signed-in staff are swapped for Firm A's, so the RLS lookups before any signing are the real ones. Vitest isolates
// mocks per file.
const actAs = vi.hoisted(() => ({ client: null as unknown, staff: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => actAs.client }));
vi.mock("@/lib/auth/staff", () => ({ requireStaff: async () => actAs.staff }));

let A: Firm, B: Firm, inv: Inventory;
let C: { office: string; admin: SupabaseClient };
let firmTables: string[];
let before: Record<string, string>;
const svc = () => adminClient();
/** Case-by-case notes for the evidence report (AC-14): written only when XF_REPORT names a file. */
const note = (section: string, lines: string[]) => {
  if (process.env.XF_REPORT) appendFileSync(process.env.XF_REPORT, `[${section}]\n${lines.join("\n")}\n\n`);
};
/** Case IDs that actually ran (review B-1): the last describe checks every claim in coverage.ts against this set. */
const ran = new Set<string>();

type Res = { error: { message: string; code?: string } | null; data: unknown };
/** Errors that say the *payload* is wrong, not that the object is someone else's: never proof (review I-6). */
// By message, not SQLSTATE: our named tenant checks (CLIENT_OFFICE …) are raised with 23514 too.
const INVALID = /duplicate key|null value in column|violates check constraint "|violates not-null|invalid input syntax|could not find the function/i;
/** Error codes our triggers and functions raise when an argument is another firm's object: a tenant refusal by name. */
const TENANT_REFUSAL = /_OFFICE\b|PLAN_MISMATCH|ASSIGNEE|INCHARGE|another office|\bPATH\b/;
/** A refusal every caller gets for a direct write (RLS write policy closed, grant, or "only through the vault's functions"). */
const CLOSED = /row-level security|permission denied/;
const errText = (r: Res) => `${r.error?.message ?? ""} ${r.error?.code ?? ""}`;
/** The same refusal for Firm A's own object: the change is closed for every caller (e.g. DSC_CLIENT_FIXED, IMMUTABLE). */
const sameRefusal = (a: Res, c: Res | null) => !!a.error && !!c?.error && a.error.message.split(":")[0] === c.error.message.split(":")[0];

/** The seeded row of `table` for firm f (service role). */
async function rowOf(table: string, f: Firm) {
  const r = ROW[table];
  const { data, error } = await svc().from(table).select("*").eq(r.column, r.value(f)).limit(1).maybeSingle();
  if (error) throw new Error(`rowOf ${table}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

beforeAll(async () => {
  inv = await inventory();
  firmTables = inv.tables.filter((t) => t.office_id).map((t) => t.name);
  ({ A, B } = await seedTwoFirms());
  C = await seedEmptyFirm();
  before = await snapshot(B.office, firmTables);
}, 600_000);

afterAll(async () => {
  // X5: nothing Firm A did in this file changed any of Firm B's rows, its office row included (I-2).
  expect(changedTables(before, await snapshot(B.office, firmTables)), "Firm B changed").toEqual([]);
  // I-1: no Firm A row points at one of Firm B's objects through any foreign key — run after *every* section, so a
  // void function that "succeeded" with a mixed argument is caught here.
  const bIds = new Set([...Object.values(PARENT), ...Object.values(PARENT2)].map((p) => String(p(B))));
  const found: string[] = [];
  for (const t of inv.tables.filter((x) => x.office_id)) {
    for (const f of t.fks.filter((x) => x.columns.length === 1 && x.references !== "office")) {
      const { data, error } = await svc().from(t.name).select(f.columns[0]).eq("office_id", A.office).in(f.columns[0], [...bIds]);
      if (error) throw new Error(`${t.name}.${f.columns[0]}: ${error.message}`);
      if ((data ?? []).length) found.push(`${t.name}.${f.columns[0]}`);
    }
  }
  expect(found, "a Firm A row points at Firm B").toEqual([]);
  // …and no Firm A activity row or notification names one of Firm B's objects.
  const uuids = [B.office, ...Object.values(B.ids), ...Object.values(B.users).map((u) => u.id)].map(String).filter((n) => /^[0-9a-f-]{36}$/.test(n));
  const { data: acts } = await svc().from("activity").select("entity_id, data").eq("office_id", A.office).range(0, 9999);
  const { data: notes } = await svc().from("notification").select("entity_id, data").eq("office_id", A.office);
  expect(mentions([acts, notes], uuids), "Firm A's activity names Firm B").toEqual([]);
}, 300_000);

describe("seed (AC-1)", () => {
  it("each firm has a row in every table that carries office_id", async () => {
    const a = await rowCounts(A.office, firmTables);
    const b = await rowCounts(B.office, firmTables);
    const empty = (c: Record<string, number>) => Object.entries(c).filter(([t, n]) => n === 0 && t !== "link_attempt").map(([t]) => t);
    expect({ a: empty(a), b: empty(b) }).toEqual({ a: [], b: [] });
  }, 300_000);
});

// ── Tables (AC-4, AC-5) ────────────────────────────────────────────────────────────────────────────────────────────
const NO_APP_ACCESS = new Set(["doc_counter", "link_attempt", "platform_access", "platform_audit"]); // no policies at all (AC-5)
/** Who in Firm A can see Firm A's seeded row (the read control). Notification: only its recipient. */
const reader = (table: string, f: Firm): SupabaseClient => (table === "notification" ? f.as.staff : f.as.admin);
const noneOrRefused = (r: Res) => !!r.error || !Array.isArray(r.data) || r.data.length === 0;

describe("tables: read (X4.1)", () => {
  it.each(Object.keys(ROW))("%s: Firm A reads none of Firm B's rows; the same read finds Firm A's own", async (table) => {
    ran.add(`tables:read:${table}`);
    const r = ROW[table];
    for (const who of [reader(table, A), A.as.limited]) {
      expect(noneOrRefused(await who.from(table).select(r.column).eq(r.column, r.value(B)))).toBe(true);
      if (table !== "office") expect(noneOrRefused(await who.from(table).select("office_id").eq("office_id", B.office).limit(1))).toBe(true);
    }
    // the key column only: dsc.password_ct / upload_request.token_hash are outside the column grant, and a refused
    // `select *` would make the case pass for the wrong reason
    const mine = await reader(table, A).from(table).select(r.column).eq(r.column, r.value(A));
    if (NO_APP_ACCESS.has(table)) expect(noneOrRefused(mine)).toBe(true);
    else expect(mine.data?.length, `control: ${table} as A`).toBeGreaterThan(0);
  });

  it("doc_type_usage (the view) shows none of Firm B's types", async () => {
    ran.add("tables:view:doc_type_usage");
    expect(noneOrRefused(await A.as.admin.from("doc_type_usage").select("*").in("doc_type_id", [B.ids.bankType, B.ids.proposedType]))).toBe(true);
    const mine = await A.as.admin.from("doc_type_usage").select("*").in("doc_type_id", [A.ids.bankType]);
    expect(mine.data?.length, "control").toBeGreaterThan(0);
  });
});

/** A different valid value for a writable column (review I-3), so a successful write would change the snapshot. */
const TEXT_COLS = /name|remark|note|reason|reference|comment|label|holder/;
// `active` is left alone: switching a registration off deactivates more than the row (04's auto-waive), and the
// change can't always be undone by setting it back
function changed(col: string, v: unknown, marker: string): unknown | undefined {
  if (col === "active") return undefined;
  if (typeof v === "boolean") return !v;
  if (typeof v === "number") return v + 1;
  if (typeof v === "string" && TEXT_COLS.test(col)) return `${v.slice(0, 40)} ${marker}`;
  return undefined;
}

describe("tables: change or delete Firm B's rows (X4.2)", () => {
  it.each(Object.keys(ROW))("%s: an update to a new value, and a delete, change none of Firm B's rows", async (table) => {
    ran.add(`tables:write-B:${table}`);
    const r = ROW[table];
    const meta = inv.tables.find((t) => t.name === table)!;
    const theirs = await rowOf(table, B);
    const mine = await rowOf(table, A);
    const col = meta.update_cols.find((c) => c !== r.column && theirs && changed(c, theirs[c], "x") !== undefined);
    const lines: string[] = [];
    if (col && theirs) {
      const upd = await A.as.admin.from(table).update({ [col]: changed(col, theirs[col], A.marker) }).eq(r.column, r.value(B)).select(r.column);
      expect(noneOrRefused(upd), `${table}.${col} on B's row`).toBe(true);
      // control: the same change on Firm A's own row, then put back
      const who = table === "notification" ? A.as.staff : A.as.admin;
      const ctl = mine ? await who.from(table).update({ [col]: changed(col, mine[col], A.marker) }).eq(r.column, r.value(A)).select(r.column) : null;
      if (mine && ctl && !ctl.error) {
        await who.from(table).update({ [col]: mine[col] }).eq(r.column, r.value(A));
        expect((await rowOf(table, A))?.[col], `${table}.${col}: control put back`).toEqual(mine[col]);
      }
      lines.push(`${table}.${col}: B 0 rows · control ${!ctl ? "no A row" : ctl.error ? `closed (${ctl.error.message.slice(0, 50)})` : `${(ctl.data as unknown[]).length} row(s)`}`);
    } else lines.push(`${table}: no writable column with a different valid value — delete only (the snapshot covers B)`);
    const del = await A.as.admin.from(table).delete().eq(r.column, r.value(B)).select(r.column);
    expect(noneOrRefused(del)).toBe(true);
    if (table !== "link_attempt") expect(await rowOf(table, B), `${table}: B's row still there`).not.toBeNull();
    note("write-B", lines);
  });
});

/** Firm A's seeded row cut to the columns staff may insert, with unique-ish columns changed up front (review I-6). */
const MAKE_UNIQUE: Record<string, (v: unknown) => unknown> = {
  pan: () => null, email: () => null, mobile: () => null, number: () => null,
  code: (v) => `${String(v).slice(0, 12)}x${Math.random().toString(36).slice(2, 6)}`,
  name: (v) => `${String(v).slice(0, 60)} ${Math.random().toString(36).slice(2, 7)}`,
  label: (v) => `${String(v)} ${Math.random().toString(36).slice(2, 6)}`,
};
function insertBody(row: Record<string, unknown>, cols: string[], keep: string[]) {
  const body = Object.fromEntries(Object.entries(row).filter(([k]) => cols.includes(k) && k !== "id"));
  for (const [c, f] of Object.entries(MAKE_UNIQUE)) if (c in body && !keep.includes(c) && body[c] !== null) body[c] = f(body[c]);
  return body;
}
// return only the key column: a `returning *` touches dsc.password_ct / upload_request.token_hash (outside the grant)
const insert = (who: SupabaseClient, table: string, body: Record<string, unknown>) =>
  who.from(table).insert(body).select(ROW[table]?.column ?? "office_id") as unknown as Promise<Res>;

/** Why the attempt's refusal is the tenant check and not a bad payload; the control ran *after* the attempt. */
function proof(attempt: Res, control: Res | null): string {
  if (!attempt.error) return Array.isArray(attempt.data) && attempt.data.length > 0 ? "LEAK" : "no row";
  if (TENANT_REFUSAL.test(attempt.error.message)) return "tenant check";
  if (INVALID.test(attempt.error.message)) return `INCONCLUSIVE (payload: ${attempt.error.message.slice(0, 60)})`;
  if (control && !control.error) return "control ok";
  if (control && CLOSED.test(attempt.error.message) && CLOSED.test(control.error!.message)) return "closed for everyone";
  if (sameRefusal(attempt, control)) return `closed for everyone (${attempt.error.message.split(":")[0]})`;
  return `INCONCLUSIVE (${attempt.error.message.slice(0, 60)}${control?.error ? ` · control: ${control.error.message.slice(0, 40)}` : ""})`;
}

describe("tables: insert into Firm B (X4.3)", () => {
  it("no table takes a row carrying Firm B's office; the same row for Firm A is accepted or closed for everyone", async () => {
    const leaks: string[] = [];
    const report: string[] = [];
    for (const t of inv.tables.filter((x) => x.office_id && x.policies.includes("INSERT") && x.name in ROW)) {
      ran.add(`tables:insert-B:${t.name}`);
      const mine = await rowOf(t.name, A);
      if (!mine) throw new Error(`seed: no row of ${t.name} in A`);
      // a financial year must be a new, valid year (a copy of the seeded one breaks its own checks)
      const body = t.name === "financial_year" ? { code: "2040-41", start_date: "2040-04-01", end_date: "2041-03-31" }
        : insertBody(mine, t.insert_cols, ["office_id"]);
      const attempt = await insert(A.as.admin, t.name, { ...body, office_id: B.office });
      const control = await insert(A.as.admin, t.name, { ...body, office_id: A.office });
      const why = proof(attempt, control);
      if (why === "LEAK" || why.startsWith("INCONCLUSIVE")) leaks.push(`${t.name}: ${why}`);
      report.push(`${t.name}: ${why}`);
    }
    note("insert-B", report);
    expect(leaks).toEqual([]);
  }, 600_000);
});

describe("tables: point Firm A's rows at Firm B's objects (X4.4)", () => {
  type Fk = { table: string; column: string; references: string; update: boolean; insert: boolean; insertCols: string[] };
  const fks = (): Fk[] => inv.tables.filter((t) => t.office_id && t.name in ROW).flatMap((t) =>
    t.fks.filter((f) => f.columns.length === 1 && f.references !== "office" && f.references in PARENT)
      .map((f) => ({
        table: t.name, column: f.columns[0], references: f.references, insertCols: t.insert_cols,
        update: t.policies.includes("UPDATE") && t.update_cols.includes(f.columns[0]),
        insert: t.policies.includes("INSERT") && t.insert_cols.includes(f.columns[0]),
      })));

  it("lists every foreign key it doesn't try, with the reason (review N-4)", () => {
    const skipped = inv.tables.filter((t) => t.office_id).flatMap((t) => t.fks.filter((f) => f.references !== "office").flatMap((f) => {
      const why = f.columns.length !== 1 ? "multi-column" : !(f.references in PARENT) ? "no seeded parent of that kind"
        : !(t.name in ROW) ? "no seeded row"
        : !t.update_cols.includes(f.columns[0]) && !t.insert_cols.includes(f.columns[0]) ? "column not writable by staff (grant)" : null;
      return why ? [`${t.name}.${f.columns.join(",")} → ${f.references}: ${why}`] : [];
    }));
    note("fk not tried", skipped);
    // a FOR ALL policy would hide insert/update from the case list: none exists today
    expect(inv.tables.filter((t) => t.policies.includes("ALL")).map((t) => t.name)).toEqual([]);
    expect(skipped.filter((s) => !/grant|no seeded/.test(s))).toEqual([]);
  });

  it("no update can set a foreign key of Firm A's row to Firm B's object (control: a second Firm A object is accepted)", async () => {
    const leaks: string[] = [];
    const report: string[] = [];
    for (const fk of fks().filter((f) => f.update)) {
      ran.add(`tables:references:${fk.table}`);
      const mine = await rowOf(fk.table, A);
      if (!mine) throw new Error(`seed: no row of ${fk.table} in A`);
      const r = ROW[fk.table];
      const theirId = PARENT[fk.references](B);
      const attempt = await A.as.admin.from(fk.table).update({ [fk.column]: theirId }).eq(r.column, r.value(A)).select(r.column) as unknown as Res;
      const after = await rowOf(fk.table, A);
      if (after?.[fk.column] === theirId) leaks.push(`${fk.table}.${fk.column} → B's ${fk.references}: STORED`);
      // control after the attempt: a second Firm A object of the same kind, then put the original back
      const second = PARENT2[fk.references]?.(A);
      const ctlValue = second && second !== mine[fk.column] ? second : mine[fk.column];
      const control = await A.as.admin.from(fk.table).update({ [fk.column]: ctlValue }).eq(r.column, r.value(A)).select(r.column) as unknown as Res;
      if (!control.error && ctlValue !== mine[fk.column]) await A.as.admin.from(fk.table).update({ [fk.column]: mine[fk.column] }).eq(r.column, r.value(A));
      const why = attempt.error ? proof(attempt, control) : after?.[fk.column] === theirId ? "LEAK" : "not stored (value kept)";
      if (why.startsWith("INCONCLUSIVE")) leaks.push(`${fk.table}.${fk.column}: ${why}`);
      report.push(`${fk.table}.${fk.column}: ${why}${ctlValue !== mine[fk.column] ? " (control: second A object)" : " (control: same value)"}`);
    }
    note("xref update", report);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("no insert can create a Firm A row whose foreign key is Firm B's object (control after, same body with A's object)", async () => {
    const leaks: string[] = [];
    const report: string[] = [];
    for (const fk of fks().filter((f) => f.insert)) {
      ran.add(`tables:references:${fk.table}`);
      const mine = await rowOf(fk.table, A);
      if (!mine) throw new Error(`seed: no row of ${fk.table} in A`);
      const body = insertBody(mine, fk.insertCols, ["office_id", fk.column]);
      const attempt = await insert(A.as.admin, fk.table, { ...body, [fk.column]: PARENT[fk.references](B) });
      const control = await insert(A.as.admin, fk.table, { ...insertBody(mine, fk.insertCols, ["office_id", fk.column]), [fk.column]: PARENT[fk.references](A) });
      const why = proof(attempt, control);
      if (why === "LEAK" || why.startsWith("INCONCLUSIVE")) leaks.push(`${fk.table}.${fk.column} → B's ${fk.references}: ${why}`);
      report.push(`${fk.table}.${fk.column}: ${why}`);
    }
    note("xref insert", report);
    expect(leaks).toEqual([]);
  }, 600_000);
});

// ── Files (AC-12) ──────────────────────────────────────────────────────────────────────────────────────────────────
describe("files: Firm A gets no file of Firm B's (AC-12)", () => {
  const BUCKET = "documents";
  beforeAll(() => {
    actAs.client = A.as.admin;
    actAs.staff = { id: A.users.admin.id, officeId: A.office, officeName: "XF A", officeBranch: null, fullName: "XF", email: A.users.admin.email, role: "admin" };
  });

  it("(a) direct Storage calls on Firm B's object are refused: download, signed URL, list, upload, move", async () => {
    const st = A.as.admin.storage.from(BUCKET);
    expect((await st.download(B.ids.softPath)).data).toBeNull();
    expect((await st.createSignedUrl(B.ids.softPath, 60)).data?.signedUrl ?? null).toBeNull();
    expect((await st.list(`office/${B.office}/doc`)).data ?? []).toEqual([]);
    expect((await st.upload(`office/${B.office}/doc/${B.ids.softDoc}/xf.pdf`, new Blob(["%PDF-1.4"]), { contentType: "application/pdf" })).error).not.toBeNull();
    expect((await st.move(B.ids.softPath, `office/${A.office}/doc/${A.ids.softDoc}/stolen.pdf`)).error).not.toBeNull();
    // Firm A's own object isn't reachable directly either (no Storage policies for app roles, 03): files go only
    // through server-signed links, which (b) tests with controls
    expect((await st.download(A.ids.softPath)).data).toBeNull();
    expect((await svc().storage.from(BUCKET).download(B.ids.softPath)).data, "B's object still there").not.toBeNull();
  });

  it("(b) getFileLink signs nothing for Firm B's file version; Firm A's own version gets a link", async () => {
    const { getFileLink } = await import("@/lib/documents/actions");
    for (const mode of ["download", "view"] as const) expect((await getFileLink(B.ids.softVersion, mode)).ok, `B's version (${mode})`).toBe(false);
    expect((await getFileLink(A.ids.softVersion, "download")).ok, "control: A's own version").toBe(true);
  });

  it("(b) the bulk zip lists and signs nothing of Firm B's; Firm A's own selection is listed and signed", async () => {
    const { getZipManifest, getFileLinks } = await import("@/lib/bulk/actions");
    expect(mentions(await getZipManifest([B.ids.softDoc, B.ids.linkDoc]), [B.ids.softPath, B.ids.softVersion, B.marker])).toEqual([]);
    const links = await getFileLinks([B.ids.softVersion]);
    // one entry per ID asked for; a link is only one with a URL (08: url null = not available to you)
    expect(links.ok ? links.links.filter((l) => l.url).length : 0).toBe(0);
    const myLinks = await getFileLinks([A.ids.softVersion]);
    expect(myLinks.ok && myLinks.links.filter((l) => l.url).length, "control: A's own version is signed").toBe(1);
    expect(JSON.stringify(await getZipManifest([A.ids.softDoc])), "control: A's own document").toContain(A.ids.softVersion);
  });

  it("(b) currentFiles finds no file for Firm B's documents; Firm A's own is found", async () => {
    const { currentFiles } = await import("@/lib/documents/queries");
    const m = await currentFiles([B.ids.softDoc, A.ids.softDoc]);
    expect(m.get(B.ids.softDoc) ?? null).toBeNull();
    expect(m.get(A.ids.softDoc), "control").toBeTruthy();
  });

  it("(b) startUpload won't issue an upload ticket for Firm B's document; a new file is always under Firm A's office", async () => {
    const { startUpload } = await import("@/lib/documents/actions");
    expect((await startUpload({ name: "x.pdf", size: 100, type: "application/pdf", documentId: B.ids.softDoc })).ok).toBe(false);
    expect((await startUpload({ name: "x.pdf", size: 100, type: "application/pdf", documentId: A.ids.softDoc })).ok, "control").toBe(true);
    const fresh = await startUpload({ name: "x.pdf", size: 100, type: "application/pdf" });
    expect(fresh.ok && JSON.stringify(fresh).includes(`office/${A.office}/`)).toBe(true);
    expect(JSON.stringify(fresh)).not.toContain(B.office);
  });
});

// ── Service-role functions: 10's public upload-link path (AC-9, AC-10) ───────────────────────────────────────────
describe("upload links: Firm A's valid link can't reach Firm B (AC-9)", () => {
  const ip = () => createHash("sha256").update(randomBytes(16)).digest("hex"); // a fresh IP each call: no throttle
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const failed = (r: Res) => r.error !== null || (r.data as { error?: string } | null)?.error !== undefined;
  let tokenHash: string;
  let aItem: string;

  beforeAll(async () => {
    // a fresh link of Firm A with three open ad-hoc items: one for these cases, two for the function controls
    // (create_document_for_item; cancel / reopen) — the seeded link may be revoked by a later function control
    tokenHash = sha(randomBytes(32).toString("base64url"));
    const r = await A.as.staff.rpc("record_link_whatsapp", { p: { client_id: A.ids.client, token_hash: tokenHash, items: [
      { kind: "ad_hoc", doc_type_id: A.ids.bankType, note: "XF link" }, { kind: "ad_hoc", doc_type_id: A.ids.bankType, note: "XF file" },
      { kind: "ad_hoc", doc_type_id: A.ids.bankType, note: "XF cancel" },
    ] } });
    if (r.error) throw new Error(`setup link: ${r.error.message}`);
    const { data } = await svc().from("upload_request_item").select("id, note").eq("request_id", (r.data as { request_id: string }).request_id);
    const byNote = Object.fromEntries((data as Array<{ id: string; note: string }>).map((i) => [i.note, i.id]));
    aItem = byNote["XF link"];
    shared.aFileItem = byNote["XF file"];
    shared.aOpenItem = byNote["XF cancel"];
  }, 60_000);

  it("link_open with Firm A's token lists only Firm A's items and nothing of Firm B's", async () => {
    ran.add("links:open");
    const r = await svc().rpc("link_open", { p_token_hash: tokenHash, p_ip_hash: ip() });
    expect(r.error).toBeNull();
    expect(JSON.stringify(r.data)).toContain(aItem); // control: the link works
    expect(mentions(r.data, [B.marker, B.office, B.ids.adHocItem, B.ids.scheduledItem, B.ids.client])).toEqual([]);
  });

  it("link_ticket for Firm B's items is refused and creates nothing; the same call for Firm A's item works", async () => {
    ran.add("links:ticket");
    for (const item of [B.ids.adHocItem, B.ids.scheduledItem]) {
      const r = await svc().rpc("link_ticket", { p_token_hash: tokenHash, p_item_id: item, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
      expect(failed(r) && !(r.data as { document_id?: string } | null)?.document_id, `ticket for B's item ${item}`).toBe(true);
    }
    const ok = await svc().rpc("link_ticket", { p_token_hash: tokenHash, p_item_id: aItem, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
    expect((ok.data as { document_id?: string } | null)?.document_id, "control: ticket for A's item").toBeTruthy();
  });

  it("link_register files nothing into Firm B's item and won't take Firm B's stored object; Firm A's own upload is filed (review I-8)", async () => {
    ran.add("links:register");
    const t = await svc().rpc("link_ticket", { p_token_hash: tokenHash, p_item_id: aItem, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
    const docId = (t.data as { document_id: string }).document_id;
    const mine = await uploadObject(A.office, "pdf", docId);
    // one change at a time: A's own fresh object, but B's item
    expect(failed(await svc().rpc("link_register", { p_token_hash: tokenHash, p_item_id: B.ids.adHocItem,
      p_file: { storage_path: mine.path, file_name: "x.pdf" }, p_ip_hash: ip() }))).toBe(true);
    // A's item, but B's stored object
    expect(failed(await svc().rpc("link_register", { p_token_hash: tokenHash, p_item_id: aItem,
      p_file: { storage_path: B.ids.softPath, file_name: "x.pdf" }, p_ip_hash: ip() }))).toBe(true);
    // control: A's item with A's object is filed
    const ok = await svc().rpc("link_register", { p_token_hash: tokenHash, p_item_id: aItem,
      p_file: { storage_path: mine.path, file_name: "x.pdf" }, p_ip_hash: ip() });
    expect(failed(ok), `control: ${JSON.stringify(ok.error ?? ok.data).slice(0, 120)}`).toBe(false);
    const { count } = await svc().from("document_version").select("id", { count: "exact", head: true })
      .eq("office_id", A.office).eq("storage_path", B.ids.softPath);
    expect(count).toBe(0);
  });

  it("Firm B's live token never opens anything for Firm A's items", async () => {
    const open = await svc().rpc("link_open", { p_token_hash: B.ids.linkTokenHash, p_ip_hash: ip() });
    expect(JSON.stringify(open.data), "control: B's token is live").toContain(B.ids.scheduledItem);
    const r = await svc().rpc("link_ticket", { p_token_hash: B.ids.linkTokenHash, p_item_id: aItem, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
    expect((r.data as { document_id?: string } | null)?.document_id ?? null).toBeNull();
  });
});

describe("service-role functions and no-policy tables (AC-5, AC-10)", () => {
  it("every service-role-only function is refused for anon and for Firm A's Admin by the grant", async () => {
    ran.add("service-role");
    const svcOnly = inv.functions.filter((f) => f.schema === "public" && f.service_role && !f.authenticated && !f.anon);
    expect(svcOnly.length).toBeGreaterThan(10);
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const open: string[] = [];
    for (const f of svcOnly) {
      for (const [who, client] of [["anon", anon], ["admin", A.as.admin]] as const) {
        // the function's own argument names (nulls), so PostgREST finds it and the answer is the grant's
        const args = Object.fromEntries(f.args.split(",").map((a) => a.trim().split(/\s+/)[0]).filter(Boolean).map((n) => [n, null]));
        const r = await client.rpc(f.name, args) as unknown as Res;
        if (!r.error || !/permission denied|42501/.test(errText(r))) open.push(`${who}: ${f.name} (${r.error?.message.slice(0, 60) ?? "ran"})`);
      }
    }
    expect(open).toEqual([]);
  }, 120_000);

  it("tables with no app policies (login_attempt, test_lane, doc_counter, link_attempt, platform_access, platform_audit) give Firm A nothing and refuse writes", async () => {
    for (const table of ["login_attempt", "test_lane", "doc_counter", "link_attempt", "platform_access", "platform_audit"]) {
      ran.add(`tables:no-policy:${table}`);
      expect(noneOrRefused(await A.as.admin.from(table).select("*").limit(1) as unknown as Res)).toBe(true);
      const w = await A.as.admin.from(table).insert({}).select("*");
      expect(w.error?.message ?? "inserted", `${table} insert`).toMatch(CLOSED);
    }
  });
});

// ── Functions staff can call (AC-6–AC-8) ───────────────────────────────────────────────────────────────────────────
/** Every leaf number is 0 and nothing else is non-empty (a firm with no data). */
const allZero = (v: unknown): boolean =>
  v === null || v === undefined || v === 0 || v === false || v === "" ||
  (Array.isArray(v) ? v.every(allZero) : typeof v === "object" ? Object.values(v as object).every(allZero) : false);
/** A write that was refused: an error, or 08's bulk answer with every ID skipped. */
const refused = (r: Res) => !!r.error ||
  (Array.isArray(r.data) && r.data.length > 0 && r.data.every((x) => (x as { result?: string })?.result === "skipped")) ||
  (!!r.data && typeof r.data === "object" && !Array.isArray(r.data) && "skipped" in r.data &&
    isEmpty(Object.fromEntries(Object.entries(r.data as object).filter(([k]) => k !== "skipped"))));

describe("functions: Firm A calls with Firm B's IDs (AC-6–AC-8; run in order)", () => {
  // IDs and the marker as text. B's activity row ID is a short number on a fresh database (290 on CI's local stack,
  // main CI 41897661172) and would match any number in Firm A's answer, so short values are checked exactly instead
  // (numericIds below), as 19's window case does.
  const bNeedles = () => [B.marker, B.office, ...Object.values(B.ids).filter((v) => v !== null).map(String), ...Object.values(B.users).map((u) => u.id)]
    .filter((n) => n.length >= 8);
  /** Every number stored under an "id" key anywhere in a result (activity rows are identified by bigint IDs). */
  const numericIds = (v: unknown): number[] => Array.isArray(v) ? v.flatMap(numericIds)
    : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => (k === "id" && typeof x === "number" ? [x] : numericIds(x))) : [];
  it.each(FN_CASES.map((c) => [c.fn, c] as const))("%s", async (_name, c: FnCase) => {
    ran.add(`functions:${c.fn}`);
    const who = A.as[c.as ?? "admin"];
    const lines: string[] = [];
    const problems: string[] = [];
    // attempts first, controls after: a control changes Firm A's state (a merge, an archive), which must not be what
    // makes a mixed attempt fail. Attempts sharing the case's control run it once.
    const results: Array<{ label: string; r: Res; control: Res | null }> = [];
    for (const at of c.attempts) {
      const args = await at.args(A, B);
      results.push({ label: at.label, r: (c.kind === "firm-wide" ? await C.admin.rpc(c.fn, args) : await who.rpc(c.fn, args)) as unknown as Res, control: null });
    }
    let caseControl: Res | null = null;
    for (let i = 0; i < c.attempts.length; i++) {
      const own = c.attempts[i].control;
      if (own) results[i].control = await who.rpc(c.fn, await own(A)) as unknown as Res;
      else if (c.control) results[i].control = caseControl ??= await who.rpc(c.fn, await c.control(A)) as unknown as Res;
    }
    for (const { label, r, control } of results) {
      const ctl = !control ? "no control" : control.error ? `control FAILED (${control.error.message.slice(0, 60)})` : "control ok";
      if (c.kind === "firm-wide") {
        if (r.error) problems.push(`${label}: Firm C refused (${r.error.message.slice(0, 60)})`);
        else if (!allZero(r.data)) problems.push(`${label}: LEAK — Firm C sees ${JSON.stringify(r.data).slice(0, 120)}`);
        // I-7: zero for Firm C proves isolation only if the same figure isn't zero for Firm A
        if (!control || control.error || allZero(control.data)) problems.push(`${label}: Firm A's own figure is zero or failed — the case proves nothing`);
        lines.push(`${c.fn} · ${label}: ${allZero(r.data) ? "Firm C all zero" : "NOT ZERO"} · ${ctl}${control && !control.error && !allZero(control.data) ? " (non-zero)" : ""}`);
      } else if (c.kind === "read") {
        const hits = [...mentions(r.data, bNeedles()), ...(numericIds(r.data).includes(Number(B.ids.activity)) ? [`activity row ${B.ids.activity}`] : [])];
        if (hits.length) problems.push(`${label}: LEAK — returns ${hits.slice(0, 3).join(", ")}`);
        if (!control || control.error || isEmpty(control.data)) problems.push(`${label}: read control failed or empty — ${ctl}`);
        if (r.error && INVALID.test(r.error.message)) problems.push(`${label}: INCONCLUSIVE (payload: ${r.error.message.slice(0, 60)})`);
        lines.push(`${c.fn} · ${label}: ${r.error ? `refused (${r.error.message.slice(0, 50)})` : hits.length ? "LEAK" : "nothing of B"} · ${ctl}`);
      } else if (c.kind === "own-office") {
        lines.push(`${c.fn} · ${label}: ${r.error ? `error (${r.error.message.slice(0, 50)})` : "ran on own office"} (afterAll: Firm B incl. its office row unchanged)`);
      } else {
        let why: string;
        if (!refused(r)) {
          // a value back = something was done for Firm A with Firm B's argument; a void "success" is checked by the
          // afterAll scans (Firm B unchanged; no A row or activity points at B), and needs a working control
          why = r.data === null || r.data === undefined ? "accepted (void) — afterAll scans decide" : "LEAK (accepted with a result)";
          if (why.startsWith("LEAK")) problems.push(`${label}: ${why}: ${JSON.stringify(r.data).slice(0, 100)}`);
        } else if (r.error && INVALID.test(r.error.message)) {
          why = `INCONCLUSIVE (payload: ${r.error.message.slice(0, 60)})`;
        } else if (control && !control.error) {
          why = "refused · control ok";
        } else if (sameRefusal(r, control)) {
          why = `refused · closed for everyone (${r.error!.message.split(":")[0]})`;
        } else if (control) {
          why = `INCONCLUSIVE (${ctl})`;
        } else if (c.controlExempt && c.expect && r.error && c.expect.test(r.error.message)) {
          why = `refused as expected (${r.error.message.slice(0, 40)}) · no control: ${c.controlExempt}`;
        } else {
          why = `INCONCLUSIVE (no control${c.controlExempt ? ` and not ${c.expect}` : ""})`;
        }
        if (why.startsWith("INCONCLUSIVE")) problems.push(`${label}: ${why}`);
        lines.push(`${c.fn} · ${label}: ${why}${r.error ? ` [${r.error.message.slice(0, 60)}]` : ""}`);
      }
    }
    note("functions", lines);
    expect(problems).toEqual([]);
  }, 180_000);

  it("Firm A's Limited user gets no ciphertext for Firm B's DSC (refused by role first: Limited never reveals; the tenant proof is the Admin case)", async () => {
    const r = await A.as.limited.rpc("dsc_reveal", { p_id: B.ids.dsc });
    expect(r.data ?? null).toBeNull();
    expect(r.error).not.toBeNull();
  });

  it("every function staff can call has a case here", () => {
    const callable = inv.functions.filter((f) => f.schema === "public" && f.authenticated).map((f) => f.name);
    const covered = new Set(FN_CASES.map((c) => c.fn));
    expect(callable.filter((n) => !covered.has(n))).toEqual([]);
  });
});

// ── Super admins (19, spec Y9, AC-14) ──────────────────────────────────────────────────────────────────────────────
// A super admin is outside every firm. Their doors: the platform tables, the platform functions (refused for staff and
// deactivated super admins), the read views (only inside their own open window, only that firm's objects), and
// everything else (refused, because a super admin has no office). Runs after the function cases: it opens a window on
// Firm A, which adds Firm A activity rows; Firm B is never touched after the seed (the afterAll snapshot proves it).
describe("platform: super admins (19)", () => {
  let sa: { id: string; as: SupabaseClient };
  let other: { id: string; as: SupabaseClient };
  let dead: SupabaseClient;
  const NOT_SA = /NOT_PLATFORM_ADMIN/;
  /** Controls that reach past the caller check without changing anything (a too-short reason, an empty name …). */
  const SAFE: Record<string, (o: string, c: string) => Record<string, unknown>> = {
    platform_create_firm: () => ({ p: { name: "", branch: null } }),
    platform_suspend_firm: (o) => ({ p_office: o, p_reason: "x" }),
    platform_open_access: (o) => ({ p_office: o, p_reason: "x" }),
  };
  beforeAll(async () => {
    sa = await signedInPlatformAdmin("xfirm-sa");
    other = await signedInPlatformAdmin("xfirm-sa-2");
    const d = await createPlatformAdmin("xfirm-sa-dead", "deactivated");
    dead = await signedInClient(d.email);
  }, 120_000);

  it("platform tables: staff read and write nothing; a super admin reads only their own platform_admin row", async () => {
    for (const t of ["platform_admin", "platform_access", "platform_audit"]) {
      ran.add(`tables:platform:${t}`);
      for (const who of [A.as.admin, A.as.limited, sa.as]) {
        const col = t === "platform_audit" ? "id" : "id";
        const r = await who.from(t).select(col).neq(col, t === "platform_audit" ? -1 : "00000000-0000-0000-0000-000000000000").limit(5) as unknown as Res;
        if (!(who === sa.as && t === "platform_admin")) expect(noneOrRefused(r), `${t} read`).toBe(true);
        expect((await who.from(t).insert({}).select(col)).error?.message ?? "inserted", `${t} insert`).toMatch(CLOSED);
      }
    }
    const self = await sa.as.from("platform_admin").select("id");
    expect((self.data ?? []).map((r) => r.id), "control: own row only").toEqual([sa.id]);
    expect(noneOrRefused(await A.as.admin.from("platform_admin").select("id").eq("id", sa.id) as unknown as Res)).toBe(true);
  }, 120_000); // ≈ 20 calls: the 30 s default isn't enough when dev is shared with a Regression run (like its neighbours)

  it("every platform function refuses staff of Firm A and a deactivated super admin; an active one gets past the check", async () => {
    ran.add("platform:callers");
    const problems: string[] = [];
    for (const [fn, args] of Object.entries(PLATFORM_FUNCTIONS)) {
      for (const [who, client] of [["A limited", A.as.limited], ["A staff", A.as.staff], ["deactivated", dead]] as const) {
        const r = await client.rpc(fn, args(A.office, A.ids.client)) as unknown as Res;
        if (!r.error || !NOT_SA.test(r.error.message)) problems.push(`${fn} as ${who}: ${r.error?.message.slice(0, 60) ?? "ran"}`);
      }
      const ctl = await sa.as.rpc(fn, (SAFE[fn] ?? args)(A.office, A.ids.client)) as unknown as Res;
      if (ctl.error && NOT_SA.test(ctl.error.message)) problems.push(`${fn}: control refused the active super admin`);
    }
    expect(problems).toEqual([]);
  }, 300_000);

  it("a window on Firm A opens nothing of Firm B, is the opener's only, and ends when closed", async () => {
    ran.add("platform:window");
    const access = (await sa.as.rpc("platform_open_access", { p_office: A.office, p_reason: "Cross-firm sweep window" })).data as string;
    expect(access).toMatch(/^[0-9a-f-]{36}$/);
    const VIEWS: Array<[string, (o: string, client: string, docId: string) => Record<string, unknown>]> = [
      ["platform_clients", (o) => ({ p_office: o, p_query: null, p_page: 1 })],
      ["platform_client", (o, c) => ({ p_office: o, p_client: c })],
      ["platform_documents", (o, c) => ({ p_office: o, p_client: c, p_page: 1 })],
      ["platform_document", (o, _c, d) => ({ p_office: o, p_document: d })],
      ["platform_expected", (o, c) => ({ p_office: o, p_client: c, p_page: 1 })],
      ["platform_activity", (o) => ({ p_office: o, p_page: 1 })],
    ];
    // IDs and the marker as text; a short number (B's activity row ID: 290 on CI's fresh database) would match any
    // unrelated number, so it is checked exactly below instead (the same rule as "nothing outside", CI 41847…, PR #31)
    const bNeedles = [B.marker, B.office, ...Object.values(B.ids).filter((v) => v !== null).map(String), ...Object.values(B.users).map((u) => u.id)]
      .filter((n) => n.length >= 8);
    const problems: string[] = [];
    const lines: string[] = [];
    for (const [fn, args] of VIEWS) {
      const onB = await sa.as.rpc(fn, args(B.office, B.ids.client, B.ids.softDoc)) as unknown as Res;
      const mixed = await sa.as.rpc(fn, args(A.office, B.ids.client, B.ids.softDoc)) as unknown as Res;
      const noWindow = await other.as.rpc(fn, args(A.office, A.ids.client, A.ids.softDoc)) as unknown as Res;
      const ctl = await sa.as.rpc(fn, args(A.office, A.ids.client, A.ids.softDoc)) as unknown as Res;
      if (!onB.error || !/NO_ACCESS/.test(onB.error.message)) problems.push(`${fn} on B's office: ${onB.error?.message.slice(0, 60) ?? "ANSWERED"}`);
      // views that take no B object answer A's data (fine) — they must never carry B's
      const hits = mentions(mixed.data, bNeedles);
      if (hits.length) problems.push(`${fn} mixed: LEAK ${hits.slice(0, 3).join(", ")}`);
      if (["platform_client", "platform_document", "platform_expected"].includes(fn) || (fn === "platform_documents"))
        if (!mixed.error || !/NOT_FOUND/.test(mixed.error.message)) problems.push(`${fn} with B's IDs: ${mixed.error?.message.slice(0, 60) ?? "ANSWERED"}`);
      if (!noWindow.error || !/NO_ACCESS/.test(noWindow.error.message)) problems.push(`${fn} by another super admin: ${noWindow.error?.message.slice(0, 60) ?? "ANSWERED"}`);
      if (ctl.error || isEmpty(ctl.data)) problems.push(`${fn}: control failed (${ctl.error?.message.slice(0, 60) ?? "empty"})`);
      const rowIds = (r: Res) => ((r.data as { rows?: Array<{ id?: unknown }> } | null)?.rows ?? []).map((x) => x.id);
      if (fn === "platform_activity" && [...rowIds(mixed), ...rowIds(ctl)].includes(B.ids.activity)) problems.push(`${fn}: LEAK — returns Firm B's activity row`);
      else if (mentions(ctl.data, bNeedles).length) problems.push(`${fn}: control carries B`);
      lines.push(`${fn}: B office ${onB.error ? "refused" : "ANSWERED"} · B IDs ${mixed.error ? "refused" : "A only"} · other admin ${noWindow.error ? "refused" : "ANSWERED"} · control ${ctl.error ? "FAILED" : "ok"}`);
    }
    expect(JSON.stringify((await sa.as.rpc("platform_clients", { p_office: A.office, p_query: null, p_page: 1 })).data)).toContain(A.marker);
    // someone else's window can't be closed by another super admin; the opener closes it and the views stop
    expect((await other.as.rpc("platform_close_access", { p_access: access })).error?.message ?? "closed").toMatch(/NOT_FOUND/);
    expect((await sa.as.rpc("platform_clients", { p_office: A.office, p_query: null, p_page: 1 })).error).toBeNull();
    expect((await sa.as.rpc("platform_close_access", { p_access: access })).error).toBeNull();
    expect((await sa.as.rpc("platform_clients", { p_office: A.office, p_query: null, p_page: 1 })).error?.message ?? "answered").toMatch(/NO_ACCESS/);
    note("platform window", lines);
    expect(problems).toEqual([]);
  }, 300_000);

  it("a super admin reaches nothing outside the platform functions: no firm table, staff function, file or DSC", async () => {
    const aBefore = await snapshot(A.office, firmTables);
    const aNeedles = [A.marker, A.office, ...Object.values(A.ids).filter((v) => v !== null).map(String), ...Object.values(A.users).map((u) => u.id)]
      .filter((n) => n.length >= 8); // IDs and the marker (short numbers like the activity id would match anything)
    const problems: string[] = [];
    for (const t of firmTables) {
      if (!noneOrRefused(await sa.as.from(t).select("office_id").limit(1) as unknown as Res)) problems.push(`table ${t}: rows`);
    }
    for (const c of FN_CASES.filter((x) => !x.fn.startsWith("platform_") && x.fn !== "my_access_state")) {
      const build = c.control ?? c.attempts.find((a) => a.control)?.control;
      const args = build ? await build(A) : await c.attempts[0].args(A, A);
      const r = await sa.as.rpc(c.fn, args) as unknown as Res;
      // an answer may exist (e.g. today_items' date with empty cards); it must carry nothing of Firm A's
      const hits = r.error ? [] : mentions(r.data, aNeedles);
      if (hits.length) problems.push(`${c.fn}: answered with Firm A's ${hits.slice(0, 3).join(", ")}`);
    }
    for (const mode of ["download", "signed"] as const) {
      const r = mode === "download" ? await sa.as.storage.from("documents").download(A.ids.softPath)
        : await sa.as.storage.from("documents").createSignedUrl(A.ids.softPath, 60);
      if (!r.error) problems.push(`storage ${mode}: allowed`);
    }
    expect((await sa.as.rpc("my_access_state")).data).toBe("platform");
    expect(changedTables(aBefore, await snapshot(A.office, firmTables)), "Firm A changed by a super admin").toEqual([]);
    expect(problems).toEqual([]);
  }, 600_000);
});

// ── The coverage map's claims are the cases that ran (review B-1) ─────────────────────────────────────────────────
describe("coverage claims (B-1)", () => {
  it("every case coverage.ts names for a table or function ran in this file", () => {
    const missing: string[] = [];
    for (const [table, c] of Object.entries(TABLES)) {
      if (!("cases" in c)) continue;
      for (const name of c.cases) {
        const shape = name.replace(/^tables:/, "");
        // "references" runs only for tables with a writable foreign key; others claim it through their insert/read cases
        if (shape === "references" && !ran.has(`tables:references:${table}`)) {
          const t = inv.tables.find((x) => x.name === table);
          const writableFk = t?.fks.some((f) => f.references !== "office" && f.columns.length === 1 && f.references in PARENT &&
            (t.update_cols.includes(f.columns[0]) || t.insert_cols.includes(f.columns[0])));
          if (writableFk) missing.push(`${table}: references`);
          continue;
        }
        if (shape === "insert-B" && !inv.tables.find((x) => x.name === table)?.policies.includes("INSERT")) continue;
        if (!ran.has(`tables:${shape}:${table}`)) missing.push(`${table}: ${shape}`);
      }
    }
    for (const [key, c] of Object.entries(FUNCTIONS)) {
      if (!("cases" in c)) continue;
      for (const name of c.cases) if (!ran.has(name)) missing.push(`${key}: ${name}`);
    }
    expect(missing).toEqual([]);
  });
});
