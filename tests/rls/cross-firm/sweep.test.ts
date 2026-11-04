import { appendFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "../../support/db";
import { inventory, type Inventory } from "./inventory";
import { rowCounts, seedEmptyFirm, seedTwoFirms, type Firm } from "./seed";
import { changedTables, isEmpty, mentions, snapshot } from "./helpers";
import { FN_CASES } from "./functions";
import { PARENT, ROW } from "./rows";

// Feature 18 — the cross-firm sweep (spec AC-1, AC-4–AC-13). Firm A's staff (Admin unless stated, spec X3) try every
// door into Firm B. One seed per run (plan step 2: ≈ 2 min on dev from a session), so the sections share this file.
// Every refusal is paired with a control (plan: "Proving a refusal is the tenant refusal"): the same call on Firm A's
// own object must work, so a case can't pass because of a bad argument.

// Step 6 (AC-12 b): the app's own file-link code runs here as Firm A's signed-in Admin. Its Supabase client and
// signed-in staff are swapped for Firm A's, so the RLS lookups before any signing are the real ones.
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
  // X5: nothing Firm A did in this file changed any of Firm B's rows.
  const after = await snapshot(B.office, firmTables);
  expect(changedTables(before, after)).toEqual([]);
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
const NO_APP_ACCESS = new Set(["doc_counter", "link_attempt"]); // no policies at all (AC-5)
/** Who in Firm A can see Firm A's seeded row (the read control). Notification: only its recipient. */
const reader = (table: string, f: Firm): SupabaseClient => (table === "notification" ? f.as.staff : f.as.admin);

describe("tables: read (X4.1)", () => {
  it.each(Object.keys(ROW))("%s: Firm A reads none of Firm B's rows; the same read finds Firm A's own", async (table) => {
    const r = ROW[table];
    for (const who of [reader(table, A), A.as.limited]) {
      const theirs = await who.from(table).select(r.column).eq(r.column, r.value(B));
      expect(theirs.error ?? theirs.data ?? []).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
      if (table !== "office") {
        const all = await who.from(table).select("office_id").eq("office_id", B.office).limit(1);
        expect(all.error ?? all.data ?? []).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
      }
    }
    // select the key column only: dsc.password_ct and upload_request.token_hash are outside the column grant, and a
    // refused `select *` would make the case pass for the wrong reason
    const mine = await reader(table, A).from(table).select(r.column).eq(r.column, r.value(A));
    if (NO_APP_ACCESS.has(table)) expect(mine.error ?? mine.data).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
    else expect(mine.data?.length, `control: ${table} as A`).toBeGreaterThan(0);
  });

  it("doc_type_usage (the view) shows none of Firm B's types", async () => {
    const theirs = await A.as.admin.from("doc_type_usage").select("*").in("doc_type_id", [B.ids.bankType, B.ids.proposedType]);
    expect(theirs.error ?? theirs.data).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
    const mine = await A.as.admin.from("doc_type_usage").select("*").in("doc_type_id", [A.ids.bankType]);
    expect(mine.data?.length, "control").toBeGreaterThan(0);
  });
});

describe("tables: change or delete Firm B's rows (X4.2)", () => {
  it.each(Object.keys(ROW))("%s: an update of a writable column, and a delete, change none of Firm B's rows", async (table) => {
    const r = ROW[table];
    const meta = inv.tables.find((t) => t.name === table)!;
    const col = meta.update_cols.find((c) => c !== r.column);
    const theirs = await rowOf(table, B);
    if (col && theirs) {
      const upd = await A.as.admin.from(table).update({ [col]: theirs[col] }).eq(r.column, r.value(B)).select(r.column);
      expect(upd.error ?? upd.data).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
      note("update control", [`${table}.${col}: ${await updateControl(table, col)}`]);
    }
    const del = await A.as.admin.from(table).delete().eq(r.column, r.value(B)).select(r.column);
    expect(del.error ?? del.data).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
    if (table !== "link_attempt") expect(await rowOf(table, B), `${table}: B's row still there`).not.toBeNull();
  });
});

/** The same update on Firm A's own row (value unchanged): "1 row" proves the column is writable, so B's 0 is the tenant. */
async function updateControl(table: string, col: string) {
  const r = ROW[table];
  const mine = await rowOf(table, A);
  if (!mine) return "no A row";
  const who = table === "notification" ? A.as.staff : A.as.admin;
  const res = await who.from(table).update({ [col]: mine[col] }).eq(r.column, r.value(A)).select(r.column);
  return res.error ? `closed (${res.error.message.slice(0, 50)})` : `${res.data?.length ?? 0} row(s)`;
}

/** Firm A's seeded row cut to the columns staff may insert, made unique where a unique key needs it. */
const payloadFrom = (row: Record<string, unknown>, cols: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => cols.includes(k) && k !== "id"));
/** Text columns a unique key may need changed for a second copy of a row (others are left alone). */
const MAKE_UNIQUE: Record<string, (v: unknown) => unknown> = {
  pan: () => null, email: () => null, mobile: () => null,
  code: (v) => `${String(v).slice(0, 12)}x${Math.random().toString(36).slice(2, 6)}`,
  name: (v) => `${String(v).slice(0, 60)} ${Math.random().toString(36).slice(2, 7)}`,
  number: () => null, label: (v) => `${String(v)} ${Math.random().toString(36).slice(2, 6)}`,
};
async function insertWithRetry(who: SupabaseClient, table: string, payload: Record<string, unknown>, keep: string[]) {
  // return only the key column: a `returning *` touches dsc.password_ct / upload_request.token_hash, which are outside
  // the column grant, and that refusal would make any insert look refused
  const key = ROW[table]?.column ?? "office_id";
  let body = { ...payload };
  for (let i = 0; i < 4; i++) {
    const res = await who.from(table).insert(body).select(key);
    if (!res.error || !/duplicate key/.test(res.error.message)) return { res, body };
    const cols = Object.keys(MAKE_UNIQUE).filter((c) => c in body && !keep.includes(c) && body[c] !== null);
    if (!cols.length) return { res, body };
    body = { ...body, ...Object.fromEntries(cols.map((c) => [c, MAKE_UNIQUE[c](body[c])])) };
  }
  return { res: await who.from(table).insert(body).select(key), body };
}

/** Error codes our triggers raise when a row points at another firm's object: a tenant refusal by name. */
const TENANT_REFUSAL = /_OFFICE\b|PLAN_MISMATCH|ASSIGNEE|INCHARGE|another office/;
/** A refusal every caller gets for a direct write (RLS write policy closed, grant, or "only through the vault's functions"). */
const CLOSED = /row-level security|permission denied/;
type Res = { error: { message: string } | null; data: unknown[] | null };
/** proof = why the attempt's refusal is the tenant check and not a bad payload (plan: controls). */
function proof(attempt: Res, control: Res): string {
  if (!attempt.error) return (attempt.data?.length ?? 0) > 0 ? "LEAK" : "no row";
  if (TENANT_REFUSAL.test(attempt.error.message)) return "tenant check";
  if (!control.error) return "control ok";
  if (CLOSED.test(attempt.error.message) && CLOSED.test(control.error.message)) return "closed for everyone";
  return `INCONCLUSIVE (${attempt.error.message.slice(0, 60)})`;
}

describe("tables: point Firm A's rows at Firm B's objects (X4.4)", () => {
  type Fk = { table: string; column: string; references: string; update: boolean; insert: boolean; insertCols: string[] };
  const fks = (): Fk[] => inv.tables.filter((t) => t.office_id && t.name in ROW).flatMap((t) =>
    t.fks.filter((f) => f.columns.length === 1 && f.references !== "office" && f.references in PARENT)
      .map((f) => ({
        table: t.name, column: f.columns[0], references: f.references, insertCols: t.insert_cols,
        update: t.policies.includes("UPDATE") && t.update_cols.includes(f.columns[0]),
        insert: t.policies.includes("INSERT") && t.insert_cols.includes(f.columns[0]),
      })));

  it("no update can set a foreign key of Firm A's row to Firm B's object (control: setting it to its own value works or is closed for everyone)", async () => {
    const leaks: string[] = [];
    const report: string[] = [];
    for (const fk of fks().filter((f) => f.update)) {
      const mine = await rowOf(fk.table, A);
      if (!mine) throw new Error(`seed: no row of ${fk.table} in A`);
      const r = ROW[fk.table];
      const theirId = PARENT[fk.references](B);
      const attempt = await A.as.admin.from(fk.table).update({ [fk.column]: theirId }).eq(r.column, r.value(A)).select(r.column);
      const after = await rowOf(fk.table, A);
      if (after?.[fk.column] === theirId) leaks.push(`${fk.table}.${fk.column} → B's ${fk.references}: stored`);
      const control = await A.as.admin.from(fk.table).update({ [fk.column]: mine[fk.column] }).eq(r.column, r.value(A)).select(r.column);
      const why = attempt.error ? proof(attempt, control) : "not stored (value kept)";
      if (why.startsWith("INCONCLUSIVE")) leaks.push(`${fk.table}.${fk.column}: ${why}`);
      report.push(`${fk.table}.${fk.column}: ${why}`);
    }
    note("xref update", report);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("no insert can create a Firm A row whose foreign key is Firm B's object", async () => {
    const leaks: string[] = [];
    const report: string[] = [];
    for (const fk of fks().filter((f) => f.insert)) {
      const mine = await rowOf(fk.table, A);
      if (!mine) throw new Error(`seed: no row of ${fk.table} in A`);
      const theirId = PARENT[fk.references](B);
      // control first (A's own parent), so the attempt uses a payload known to be accepted
      const ctl = await insertWithRetry(A.as.admin, fk.table, payloadFrom(mine, fk.insertCols), ["office_id", fk.column]);
      const control = ctl.res;
      const attempt = (await insertWithRetry(A.as.admin, fk.table, { ...ctl.body, [fk.column]: theirId }, ["office_id", fk.column])).res;
      const why = proof(attempt, control);
      if (why === "LEAK" || why === "control ok" && !attempt.error || why.startsWith("INCONCLUSIVE")) leaks.push(`${fk.table}.${fk.column} → B's ${fk.references}: ${why}`);
      report.push(`${fk.table}.${fk.column}: ${why}`);
    }
    note("xref insert", report);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("afterwards, no Firm A row references any of Firm B's seeded objects (service-role check over every foreign key)", async () => {
    const bIds = new Set(Object.values(PARENT).map((p) => String(p(B))));
    const found: string[] = [];
    for (const t of inv.tables.filter((x) => x.office_id)) {
      for (const f of t.fks.filter((x) => x.columns.length === 1 && x.references !== "office")) {
        const { data, error } = await svc().from(t.name).select(f.columns[0]).eq("office_id", A.office).in(f.columns[0], [...bIds]);
        if (error) throw new Error(`${t.name}.${f.columns[0]}: ${error.message}`);
        if ((data ?? []).length) found.push(`${t.name}.${f.columns[0]}`);
      }
    }
    expect(found).toEqual([]);
  }, 300_000);
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
    const dl = await st.download(B.ids.softPath);
    expect(dl.data).toBeNull();
    const signed = await st.createSignedUrl(B.ids.softPath, 60);
    expect(signed.data?.signedUrl ?? null).toBeNull();
    const list = await st.list(`office/${B.office}/doc`);
    expect(list.data ?? []).toEqual([]);
    const up = await st.upload(`office/${B.office}/doc/${B.ids.softDoc}/xf.pdf`, new Blob(["%PDF-1.4"]), { contentType: "application/pdf" });
    expect(up.error).not.toBeNull();
    const mv = await st.move(B.ids.softPath, `office/${A.office}/doc/${A.ids.softDoc}/stolen.pdf`);
    expect(mv.error).not.toBeNull();
    // control: Firm A's own object isn't reachable directly either (no Storage policies for app roles, 03): files go
    // only through server-signed links, which (b) tests
    expect((await st.download(A.ids.softPath)).data).toBeNull();
    const { data: still } = await svc().storage.from(BUCKET).download(B.ids.softPath);
    expect(still, "B's object still there").not.toBeNull();
  });

  it("(b) getFileLink signs nothing for Firm B's file version; Firm A's own version gets a link", async () => {
    const { getFileLink } = await import("@/lib/documents/actions");
    for (const mode of ["download", "view"] as const) {
      const theirs = await getFileLink(B.ids.softVersion, mode);
      expect(theirs.ok, `B's version (${mode})`).toBe(false);
    }
    const mine = await getFileLink(A.ids.softVersion, "download");
    expect(mine.ok, "control: A's own version").toBe(true);
  });

  it("(b) the bulk zip lists and signs nothing of Firm B's; Firm A's own selection is listed", async () => {
    const { getZipManifest, getFileLinks } = await import("@/lib/bulk/actions");
    const theirs = await getZipManifest([B.ids.softDoc, B.ids.linkDoc]);
    expect(mentions(theirs, [B.ids.softPath, B.ids.softVersion, B.marker])).toEqual([]);
    const links = await getFileLinks([B.ids.softVersion]);
    // one entry per ID asked for; a link is only one with a URL (08: url null = not available to you)
    expect(links.ok ? links.links.filter((l) => l.url).length : 0).toBe(0);
    const myLinks = await getFileLinks([A.ids.softVersion]);
    expect(myLinks.ok && myLinks.links.filter((l) => l.url).length, "control: A's own version is signed").toBe(1);
    const mine = await getZipManifest([A.ids.softDoc]);
    expect(JSON.stringify(mine), "control: A's own document").toContain(A.ids.softVersion);
  });

  it("(b) currentFiles finds no file for Firm B's documents; Firm A's own is found", async () => {
    const { currentFiles } = await import("@/lib/documents/queries");
    const m = await currentFiles([B.ids.softDoc, A.ids.softDoc]);
    expect(m.get(B.ids.softDoc) ?? null).toBeNull();
    expect(m.get(A.ids.softDoc), "control").toBeTruthy();
  });

  it("(b) startUpload won't issue an upload ticket for Firm B's document; a new file is always under Firm A's office", async () => {
    const { startUpload } = await import("@/lib/documents/actions");
    const theirs = await startUpload({ name: "x.pdf", size: 100, type: "application/pdf", documentId: B.ids.softDoc });
    expect(theirs.ok).toBe(false);
    const mine = await startUpload({ name: "x.pdf", size: 100, type: "application/pdf", documentId: A.ids.softDoc });
    expect(mine.ok, "control").toBe(true);
    const fresh = await startUpload({ name: "x.pdf", size: 100, type: "application/pdf" });
    expect(fresh.ok && JSON.stringify(fresh).includes(`office/${A.office}/`)).toBe(true);
    expect(JSON.stringify(fresh)).not.toContain(B.office);
  });
});

// ── Service-role functions: 10's public upload-link path (AC-9, AC-10) ───────────────────────────────────────────
describe("upload links: Firm A's valid link can't reach Firm B (AC-9)", () => {
  const ip = () => createHash("sha256").update(randomBytes(16)).digest("hex"); // a fresh IP each call: no throttle
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  let tokenHash: string;
  let aItem: string;

  beforeAll(async () => {
    // a fresh link of Firm A (the seeded one may be revoked by a later function control)
    tokenHash = sha(randomBytes(32).toString("base64url"));
    const r = await A.as.staff.rpc("record_link_whatsapp", { p: { client_id: A.ids.client, token_hash: tokenHash,
      items: [{ kind: "ad_hoc", doc_type_id: A.ids.bankType, note: "XF control" }] } });
    if (r.error) throw new Error(`setup link: ${r.error.message}`);
    const { data } = await svc().from("upload_request_item").select("id").eq("request_id", (r.data as { request_id: string }).request_id).single();
    aItem = (data as { id: string }).id;
  }, 60_000);

  it("link_open with Firm A's token lists only Firm A's items and nothing of Firm B's", async () => {
    const r = await svc().rpc("link_open", { p_token_hash: tokenHash, p_ip_hash: ip() });
    expect(r.error).toBeNull();
    expect(JSON.stringify(r.data)).toContain(aItem); // control: the link works
    expect(mentions(r.data, [B.marker, B.office, B.ids.adHocItem, B.ids.scheduledItem, B.ids.client])).toEqual([]);
  });

  it("link_ticket for Firm B's items is refused and creates nothing; the same call for Firm A's item works", async () => {
    for (const item of [B.ids.adHocItem, B.ids.scheduledItem]) {
      const r = await svc().rpc("link_ticket", { p_token_hash: tokenHash, p_item_id: item, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
      const data = r.data as { error?: string; document_id?: string } | null;
      expect(r.error !== null || (data?.error !== undefined && !data?.document_id), `ticket for B's item ${item}`).toBe(true);
    }
    const ok = await svc().rpc("link_ticket", { p_token_hash: tokenHash, p_item_id: aItem, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
    expect((ok.data as { document_id?: string } | null)?.document_id, "control: ticket for A's item").toBeTruthy();
  });

  it("link_register can't file into Firm B's item, nor file Firm B's stored object under Firm A's item", async () => {
    const intoB = await svc().rpc("link_register", { p_token_hash: tokenHash, p_item_id: B.ids.adHocItem,
      p_file: { storage_path: B.ids.softPath, file_name: "x.pdf" }, p_ip_hash: ip() });
    expect(intoB.error !== null || (intoB.data as { error?: string } | null)?.error !== undefined).toBe(true);
    const stealB = await svc().rpc("link_register", { p_token_hash: tokenHash, p_item_id: aItem,
      p_file: { storage_path: B.ids.softPath, file_name: "x.pdf" }, p_ip_hash: ip() });
    expect(stealB.error !== null || (stealB.data as { error?: string } | null)?.error !== undefined).toBe(true);
    const { count } = await svc().from("document_version").select("id", { count: "exact", head: true })
      .eq("office_id", A.office).eq("storage_path", B.ids.softPath);
    expect(count).toBe(0);
  });

  it("Firm B's token never opens anything for Firm A's items", async () => {
    const r = await svc().rpc("link_ticket", { p_token_hash: B.ids.linkTokenHash, p_item_id: aItem, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
    expect((r.data as { document_id?: string } | null)?.document_id ?? null).toBeNull();
  });
});

describe("service-role functions and no-policy tables (AC-5, AC-10)", () => {
  it("every service-role-only function is refused for anon and for Firm A's Admin", async () => {
    const svcOnly = inv.functions.filter((f) => f.schema === "public" && f.service_role && !f.authenticated && !f.anon);
    expect(svcOnly.length).toBeGreaterThan(10);
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const open: string[] = [];
    for (const f of svcOnly) {
      for (const [who, client] of [["anon", anon], ["admin", A.as.admin]] as const) {
        // call with the function's own argument names (nulls), so PostgREST finds it and the answer is the grant's
        const args = Object.fromEntries(f.args.split(",").map((a) => a.trim().split(/\s+/)[0]).filter(Boolean).map((n) => [n, null]));
        const r = await client.rpc(f.name, args);
        if (!r.error) open.push(`${who}: ${f.name}`);
        else if (!/permission denied|42501/.test(`${r.error.message} ${(r.error as { code?: string }).code ?? ""}`)) open.push(`${who}: ${f.name} (${r.error.message.slice(0, 60)})`);
      }
    }
    expect(open).toEqual([]);
  }, 120_000);

  it("tables with no app policies (login_attempt, test_lane, doc_counter, link_attempt) give Firm A nothing and take no writes", async () => {
    for (const table of ["login_attempt", "test_lane", "doc_counter", "link_attempt"]) {
      const r = await A.as.admin.from(table).select("*").limit(1);
      expect(r.error ?? r.data).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
      const w = await A.as.admin.from(table).insert({}).select("*");
      expect(w.error, `${table} insert`).not.toBeNull();
    }
  });
});

// ── Functions staff can call (AC-6–AC-8) ───────────────────────────────────────────────────────────────────────────
/** Error texts that name the refusal as "not yours / not found in your office" (the tenant check, by name). */
const FN_TENANT = /NOT_FOUND|not found|_OFFICE|another office|MISMATCH|ASSIGNEE|INCHARGE|NOT_VISIBLE|can't see|cannot see|no such|this client's/i;
/** Every leaf number is 0 and nothing else is non-empty (a firm with no data). */
const allZero = (v: unknown): boolean =>
  v === null || v === undefined || v === 0 || v === false || v === "" ||
  (Array.isArray(v) ? v.every(allZero) : typeof v === "object" ? Object.values(v as object).every(allZero) : false);
/** A write that did nothing: refused, empty, or only a list of skipped IDs. */
const didNothing = (r: { error: unknown; data: unknown }) => {
  if (r.error) return true;
  // 08's bulk review answers one { id, result, reason } per ID: nothing happened when every one was skipped
  if (Array.isArray(r.data) && r.data.length && r.data.every((x) => x && typeof x === "object" && (x as { result?: string }).result === "skipped")) return true;
  if (r.data && typeof r.data === "object" && !Array.isArray(r.data)) {
    const rest = Object.fromEntries(Object.entries(r.data as Record<string, unknown>).filter(([k]) => k !== "skipped"));
    return isEmpty(rest);
  }
  return isEmpty(r.data);
};

describe("functions: Firm A calls with Firm B's IDs (AC-6–AC-8)", () => {
  const bNeedles = () => [B.marker, B.office, ...Object.values(B.ids).map(String), ...Object.values(B.users).map((u) => u.id)];
  it.each(FN_CASES.map((c) => [c.fn, c] as const))("%s", async (_name, c) => {
    const who = A.as[c.as ?? "admin"];
    const lines: string[] = [];
    const problems: string[] = [];
    // attempts first, control after: a control changes Firm A's state (a merge, an archive), which must not be what
    // makes a mixed attempt fail
    const results: Array<{ label: string; r: { error: { message: string } | null; data: unknown } }> = [];
    for (const at of c.attempts) {
      const args = await at.args(A, B);
      results.push({ label: at.label, r: c.kind === "firm-wide" ? await C.admin.rpc(c.fn, args) : await who.rpc(c.fn, args) });
    }
    const control = c.control ? await who.rpc(c.fn, await c.control(A)) : null;
    const controlNote = !control ? "no control" : control.error ? `control refused (${control.error.message.slice(0, 50)})` : "control ok";
    for (const { label, r } of results) {
      const at = { label };
      if (c.kind === "firm-wide") {
        if (r.error) problems.push(`${at.label}: Firm C refused (${r.error.message.slice(0, 60)})`);
        else if (!allZero(r.data)) problems.push(`${at.label}: LEAK — Firm C sees ${JSON.stringify(r.data).slice(0, 120)}`);
        lines.push(`${c.fn} · ${at.label}: ${r.error ? "error" : allZero(r.data) ? "all zero" : "NOT ZERO"}`);
        continue;
      }
      if (c.kind === "read") {
        const hits = mentions(r.data, bNeedles());
        if (hits.length) problems.push(`${at.label}: LEAK — returns ${hits.slice(0, 3).join(", ")}`);
        lines.push(`${c.fn} · ${at.label}: ${r.error ? `error (${r.error.message.slice(0, 50)})` : hits.length ? "LEAK" : "nothing of B"}`);
      } else if (c.kind === "own-office") {
        lines.push(`${c.fn} · ${at.label}: ${r.error ? `error (${r.error.message.slice(0, 50)})` : "ran on own office"}`);
      } else {
        const nothing = didNothing(r);
        const why = !nothing ? "LEAK (accepted)" : !r.error ? "no effect"
          : FN_TENANT.test(r.error.message) ? "tenant check"
          : control && !control.error ? "control ok"
          : `INCONCLUSIVE (${r.error.message.slice(0, 70)})`;
        if (why.startsWith("LEAK") || why.startsWith("INCONCLUSIVE")) problems.push(`${at.label}: ${why}`);
        lines.push(`${c.fn} · ${at.label}: ${why}${r.error ? ` [${r.error.message.slice(0, 60)}]` : ""}`);
      }
    }
    lines.push(`${c.fn} · ${controlNote}`);
    if (c.kind === "read" && control && !control.error && isEmpty(control.data)) problems.push("read control returned nothing for Firm A's own object");
    note("functions", lines);
    expect(problems).toEqual([]);
  }, 120_000);

  it("AC-7: Firm A's Limited user gets no ciphertext for Firm B's DSC", async () => {
    const r = await A.as.limited.rpc("dsc_reveal", { p_id: B.ids.dsc });
    expect(r.data ?? null).toBeNull();
    expect(r.error).not.toBeNull();
  });

  it("every function staff can call has a case here (or is a test helper exempted in coverage.ts)", () => {
    const callable = inv.functions.filter((f) => f.schema === "public" && f.authenticated).map((f) => f.name);
    const covered = new Set(FN_CASES.map((c) => c.fn));
    expect(callable.filter((n) => !covered.has(n))).toEqual([]);
  });

  it("afterwards, none of Firm A's activity or notifications names one of Firm B's objects", async () => {
    const needles = bNeedles().filter((n) => /^[0-9a-f-]{36}$/.test(n));
    const { data: acts, error } = await svc().from("activity").select("entity_id, data").eq("office_id", A.office).range(0, 4999);
    if (error) throw error;
    const { data: notes } = await svc().from("notification").select("entity_id, data").eq("office_id", A.office);
    expect(mentions([acts, notes], needles)).toEqual([]);
  }, 120_000);
});
