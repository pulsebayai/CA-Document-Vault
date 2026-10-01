import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, createCatalogueOffice, groupId, mustInsertClient } from "../support/catalogue";
import { createDocumentOffice, documentRow, mustCreateDocument, periodId, typeId } from "../support/documents";
import { testGstin, testPan, testTan } from "../support/test-data";
import { T, expectedActivity, expectedFor, expectedItem, expectedOf, generateAsOf, planRow } from "../support/expected";
import { scheduleDates } from "@/lib/expected/schedule";
import { EXPECTED_SELECT, repeatedKinds, toItem, type RawExpected } from "@/lib/expected/shape";

// Feature 04 — expected documents: generation, date maths, exclusions, per-registration fan-out, back-link,
// linking on 03's document paths, visibility and write protection (spec AC-1, AC-4 … AC-7, AC-17, AC-18,
// FY roll-over, job). Written before the migration (plan step 1). Contract: tests/support/expected.ts.
//
// Timeline of the main office (its test clock only moves forward):
//   2026-03-15  groups enabled → start periods: month 2026-03, quarter 2025-26-Q4, year 2025-26; nothing asked yet
//   2026-07-01  first generation run
// The second office ("exp-clock") runs the date-maths and FY roll-over cases up to 2028.

type Who = "admin" | "manager" | "staff" | "limited" | "outsider";
let officeId: string;
let clockOffice: string;
const u = {} as Record<Who | "clockAdmin", { id: string; email: string }>;
const as = {} as Record<Who | "clockAdmin", SupabaseClient>;
let clientA: string; // Limited is incharge; 2 active GSTINs + 1 inactive, 1 TAN
let clientB: string; // Staff is incharge; no registrations
let clientC: string; // archived before the first run
let clientD: string; // exp-clock office: Banking only, custom offsets
const reg = {} as Record<"g1" | "g2" | "gOff" | "tan", string>;
let earlyDoc: string; // filed before its item existed (back-link, AC-4)
const DENIED_OR_NOT_FOUND = new RegExp(`${DENIED.source}|NOT_FOUND`, "i");

const enable = async (who: SupabaseClient, client: string, office: string, group: string) => {
  const { error } = await who.rpc("enable_client_group", { p_client_id: client, p_doc_group_id: await groupId(office, group) });
  if (error) throw new Error(error.message);
};
const setRow = async (who: SupabaseClient, client: string, typeName: string, patch: Record<string, unknown>) => {
  const row = await planRow(client, typeName);
  const { data, error } = await who.from("client_doc_type").update(patch).eq("id", row.id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`plan row not updated: ${typeName}`);
};
const doc = async (who: SupabaseClient, typeName: string, period: string, extra: Record<string, unknown> = {}) =>
  mustCreateDocument(who, {
    client_id: clientA, doc_type_id: await typeId(officeId, typeName), period_id: await periodId(officeId, period), ...extra,
  });

beforeAll(async () => {
  officeId = await createDocumentOffice("exp-docs");
  const otherOffice = await createCatalogueOffice("exp-docs-other");
  clockOffice = await createCatalogueOffice("exp-clock");
  u.admin = await createStaff(officeId, "exp-admin", "admin");
  u.manager = await createStaff(officeId, "exp-manager", "manager");
  u.staff = await createStaff(officeId, "exp-staff", "staff");
  u.limited = await createStaff(officeId, "exp-limited", "limited");
  u.outsider = await createStaff(otherOffice, "exp-outsider", "admin");
  u.clockAdmin = await createStaff(clockOffice, "exp-clock-admin", "admin");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);

  await generateAsOf(as.admin, "2026-03-15"); // sets the clock before any plan exists
  clientA = (await mustInsertClient(as.staff, officeId, { name: "Expected A", client_type: "proprietorship", incharge_id: u.limited.id, pan: testPan("P", 4101) })).id;
  clientB = (await mustInsertClient(as.staff, officeId, { name: "Expected B", client_type: "individual", incharge_id: u.staff.id })).id;
  clientC = (await mustInsertClient(as.staff, officeId, { name: "Expected C", client_type: "individual", incharge_id: u.staff.id })).id;
  const addReg = async (kind: "gstin" | "tan", number: string) => {
    const { data, error } = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: clientA, kind, number }).select("id").single();
    if (error) throw error;
    return data.id as string;
  };
  reg.g1 = await addReg("gstin", testGstin(testPan("P", 4101), "33", 1));
  reg.g2 = await addReg("gstin", testGstin(testPan("P", 4101), "29", 2));
  reg.gOff = await addReg("gstin", testGstin(testPan("P", 4101), "27", 3));
  await as.staff.from("client_registration").update({ active: false }).eq("id", reg.gOff);
  reg.tan = await addReg("tan", testTan(4101));

  for (const g of ["GST", "TDS/TCS", "Income Tax", "Banking"]) await enable(as.staff, clientA, officeId, g);
  for (const g of ["GST", "Income Tax", "Banking"]) await enable(as.staff, clientB, officeId, g);
  await enable(as.staff, clientC, officeId, "Banking");

  // Exclusions set before the first run.
  await setRow(as.manager, clientA, T.purchase, { state: "paused" });
  await setRow(as.staff, clientA, T.notes, { state: "removed" });
  const { error: gp } = await as.manager.from("client_group").update({ state: "paused" })
    .eq("client_id", clientB).eq("doc_group_id", await groupId(officeId, "Income Tax"));
  if (gp) throw gp;
  const { error: pe } = await as.staff.rpc("create_proposed_type", { p_client_id: clientA, p_doc_group_id: await groupId(officeId, "GST"), p_name: "Expected proposed type" });
  if (pe) throw new Error(pe.message);
  const { error: ae } = await as.manager.from("client").update({ archived_at: new Date().toISOString() }).eq("id", clientC);
  if (ae) throw ae;

  // Filed before 04 existed for it: must be linked when its item is generated (AC-4).
  earlyDoc = (await doc(as.staff, T.sales, "2026-04", { registration_id: reg.g1, received_on: "2026-05-03" })).id;

  await generateAsOf(as.admin, "2026-07-01");
}, 180_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin, u.outsider, u.clockAdmin].filter(Boolean).map((x) => x.id));
});

// ── Generation (AC-1, AC-4, AC-5) ─────────────────────────────────────────────
describe("generation as of 1 Jul 2026 (AC-1)", () => {
  it("creates one item per period whose ask date has arrived, from the start period (monthly)", async () => {
    const rows = await expectedOf(clientA, T.bank);
    expect(rows.map((r) => r.period.code)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]); // Jul: asked 1 Aug
    expect(rows.every((r) => r.status === "pending" && r.registration_id === null)).toBe(true);
  });

  it("stores ask / overdue-from dates by the schedule (monthly, quarterly, yearly)", async () => {
    expect(await expectedItem(clientA, T.bank, "2026-03")).toMatchObject({ ask_on: "2026-04-01", overdue_from: "2026-04-07" });
    expect(await expectedItem(clientA, T.form16a, "2025-26-Q4")).toMatchObject({ ask_on: "2026-05-01", overdue_from: "2026-05-20" });
    expect(await expectedItem(clientA, T.form16, "2025-26")).toMatchObject({ ask_on: "2026-05-16", overdue_from: "2026-06-10" });
    // Q1 2026-27 is asked on 1 Aug: not generated yet (no "upcoming" items, architecture change 4).
    expect((await expectedOf(clientA, T.form16a)).map((r) => r.period.code)).toEqual(["2025-26-Q4"]);
  });

  it("re-running the job the same day creates nothing (unique client × type × period × registration)", async () => {
    const before = (await expectedFor(clientA)).length;
    const again = await generateAsOf(as.admin, "2026-07-01");
    expect(again.created).toBe(0);
    expect((await expectedFor(clientA)).length).toBe(before);
  });

  it("never generates for paused or removed rows, paused groups, as-needed, proposed types or archived clients", async () => {
    expect(await expectedOf(clientA, T.purchase)).toEqual([]); // row paused
    expect(await expectedOf(clientA, T.notes)).toEqual([]); // row removed
    expect(await expectedOf(clientA, T.eway)).toEqual([]); // as needed
    expect(await expectedOf(clientA, T.notice)).toEqual([]);
    expect(await expectedOf(clientA, "Expected proposed type")).toEqual([]);
    expect((await expectedFor(clientB)).filter((r) => r.doc_type.name === T.form16)).toEqual([]); // group paused
    expect(await expectedFor(clientC)).toEqual([]); // archived
  });

  it("firm records never produce items (they cannot join a plan)", async () => {
    const { error } = await as.staff.rpc("add_client_doc_type", { p_client_id: clientA, p_doc_type_id: await typeId(officeId, T.gstReturns) });
    expect(error?.message ?? "").toMatch(/FIRM_RECORD/);
    expect(await expectedOf(clientA, T.gstReturns)).toEqual([]);
  });

  it("per-registration types: one item per ACTIVE GSTIN/TAN and period (AC-5)", async () => {
    const sales = await expectedOf(clientA, T.sales);
    expect(sales.length).toBe(8); // 4 months × 2 active GSTINs
    expect(new Set(sales.map((r) => r.registration_id))).toEqual(new Set([reg.g1, reg.g2]));
    expect(sales.some((r) => r.registration_id === reg.gOff)).toBe(false);
    const tds = await expectedOf(clientA, T.salaryTds);
    expect(tds.length).toBe(4);
    expect(tds.every((r) => r.registration_id === reg.tan)).toBe(true);
  });

  it("a client with no active GSTIN gets nothing for GSTIN types, but still gets its other items (AC-5)", async () => {
    const b = await expectedFor(clientB);
    expect(b.filter((r) => r.doc_type.name === T.sales)).toEqual([]);
    expect(b.filter((r) => r.doc_type.name === T.bank).map((r) => r.period.code).sort()).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
  });

  it("links documents filed before the item existed, and the item starts received (AC-4)", async () => {
    const item = await expectedItem(clientA, T.sales, "2026-04", reg.g1);
    expect(item).toMatchObject({ status: "received", received_on: "2026-05-03", completed_by_document_id: earlyDoc });
    expect((await documentRow(earlyDoc)).expected_doc_id).toBe(item.id);
    // The same month on the other GSTIN is still open.
    expect((await expectedItem(clientA, T.sales, "2026-04", reg.g2)).status).toBe("pending");
  });

  it("writes one expected.generated activity row per run, with counts only and no actor (AC-18)", async () => {
    const rows = (await expectedActivity(officeId)).filter((r) => r.action === "expected.generated");
    expect(rows.length).toBeGreaterThanOrEqual(3); // 15 Mar, 1 Jul, 1 Jul again
    const last = rows[rows.length - 1];
    expect(last.actor_id).toBeNull();
    expect(last.entity_type).toBe("office");
    expect(Object.keys(last.data).sort()).toEqual(["created", "linked"]);
  });
});


// ── Bulk paths (nightly import-timing fix, Raja 2026-10-01, option A) ─────────────
// import_clients / create_client / enable_client_group defer generation to one run per client at the end of the
// call (04's per-row triggers made a 200-client import chunk 3.3× slower and past the 8 s statement limit).
// The result must be exactly what generating per row gave.
describe("bulk paths generate once per client, with the same result", () => {
  const shape = async (client: string) =>
    (await expectedFor(client)).map((e) => `${e.doc_type.name}|${e.period.code}|${e.registration_id ? "reg" : "-"}|${e.status}`).sort();
  const row = (n: number, groups: string[]) => {
    const pan = testPan("P", 4200 + n);
    return { name: `Expected bulk ${n}`, client_type: "proprietorship", pan, incharge_id: u.staff.id,
      registrations: [{ kind: "gstin", number: testGstin(pan, "33", 1) }, { kind: "tan", number: testTan(4200 + n) }], group_ids: groups };
  };

  it("import_clients gives each client the same items as create_client, with nothing left un-generated", async () => {
    const groups = await Promise.all(["GST", "TDS/TCS", "Banking"].map((g) => groupId(officeId, g)));
    const { data: imported, error } = await as.staff.rpc("import_clients", { p_rows: [row(1, groups), row(2, groups)] });
    expect(error).toBeNull();
    const { data: single, error: e2 } = await as.staff.rpc("create_client", { p: row(3, groups) });
    expect(e2).toBeNull();
    const reference = await shape(single.id as string);
    expect(reference.length).toBeGreaterThan(0); // the clock (1 Jul 2026) has items due for these groups
    expect(reference.some((k) => k.includes("|reg|"))).toBe(true); // per-GSTIN/TAN types included
    for (const r of imported as Array<{ client_id: string }>) expect(await shape(r.client_id)).toEqual(reference);
  });

  it("enabling a group on an existing client still generates its items at once", async () => {
    const { data, error } = await as.staff.rpc("create_client", { p: row(4, []) });
    expect(error).toBeNull();
    expect(await expectedFor(data.id as string)).toEqual([]);
    await enable(as.staff, data.id as string, officeId, "Banking");
    expect((await expectedOf(data.id as string, T.bank)).length).toBeGreaterThan(0);
  });
});

// ── Linking on 03's paths (AC-6, AC-7) ────────────────────────────────────────
describe("linking documents (AC-6, AC-7)", () => {
  it("saving a matching document marks the item received with that document's date — no extra fields", async () => {
    const d = await doc(as.staff, T.sales, "2026-05", { registration_id: reg.g2, received_on: "2026-06-04" });
    const item = await expectedItem(clientA, T.sales, "2026-05", reg.g2);
    expect(item).toMatchObject({ status: "received", received_on: "2026-06-04", completed_by_document_id: d.id });
    expect((await documentRow(d.id)).expected_doc_id).toBe(item.id);
  });

  it("a Limited user's save on a client they can see links too", async () => {
    const d = await doc(as.limited, T.bank, "2026-03", { received_on: "2026-04-02" });
    expect(await expectedItem(clientA, T.bank, "2026-03")).toMatchObject({ status: "received", completed_by_document_id: d.id });
  });

  it("a document for another period kind does not link (quarter document vs monthly plan row)", async () => {
    const d = await doc(as.staff, T.bank, "2026-27-Q1", { received_on: "2026-07-01" });
    expect((await documentRow(d.id)).expected_doc_id).toBeNull();
    for (const m of ["2026-04", "2026-05", "2026-06"]) expect((await expectedItem(clientA, T.bank, m)).status).toBe("pending");
  });

  it("a per-registration document for a different GSTIN links only that GSTIN's item", async () => {
    await doc(as.staff, T.sales, "2026-06", { registration_id: reg.g1, received_on: "2026-07-01" });
    expect((await expectedItem(clientA, T.sales, "2026-06", reg.g1)).status).toBe("received");
    expect((await expectedItem(clientA, T.sales, "2026-06", reg.g2)).status).toBe("pending");
  });

  it("a document with no GSTIN/TAN links when the client has exactly ONE active registration of that kind (Raja 2026-09-30, option b)", async () => {
    // Client E: one active GSTIN (+ one inactive), one TAN. Enabled on the 1 Jul clock → June is asked today.
    const panE = testPan("P", 4105);
    const { data, error } = await as.staff.rpc("create_client", { p: {
      name: "Expected E", client_type: "proprietorship", pan: panE, incharge_id: u.staff.id,
      registrations: [{ kind: "gstin", number: testGstin(panE, "33", 1) }, { kind: "gstin", number: testGstin(panE, "29", 2) }, { kind: "tan", number: testTan(4105) }],
    } });
    expect(error).toBeNull();
    const clientE = data.id as string;
    const { data: regs } = await as.staff.from("client_registration").select("id, number").eq("client_id", clientE);
    const off = regs!.find((r) => r.number === testGstin(panE, "29", 2))!.id;
    await as.staff.from("client_registration").update({ active: false }).eq("id", off);
    const onlyGstin = regs!.find((r) => r.number === testGstin(panE, "33", 1))!.id;
    const tanE = regs!.find((r) => r.number === testTan(4105))!.id;
    await enable(as.staff, clientE, officeId, "GST");
    await enable(as.staff, clientE, officeId, "TDS/TCS");

    const sales = await mustCreateDocument(as.staff, { client_id: clientE, doc_type_id: await typeId(officeId, T.sales), period_id: await periodId(officeId, "2026-06"), received_on: "2026-07-01" });
    expect(await expectedItem(clientE, T.sales, "2026-06", onlyGstin)).toMatchObject({ status: "received", completed_by_document_id: sales.id });
    const tds = await mustCreateDocument(as.staff, { client_id: clientE, doc_type_id: await typeId(officeId, T.salaryTds), period_id: await periodId(officeId, "2026-06"), received_on: "2026-07-01" });
    expect(await expectedItem(clientE, T.salaryTds, "2026-06", tanE)).toMatchObject({ status: "received", completed_by_document_id: tds.id });
    expect((await documentRow(sales.id)).registration_id).toBeNull(); // the document itself is not changed
  });

  it("with two or more active GSTINs, a document with no GSTIN does not link (no guessing)", async () => {
    const d = await doc(as.staff, T.sales, "2026-06", { received_on: "2026-07-01" }); // client A: g1 + g2 active
    expect((await documentRow(d.id)).expected_doc_id).toBeNull();
    expect((await expectedItem(clientA, T.sales, "2026-06", reg.g2)).status).toBe("pending");
  });

  it("classifying an Inbox document links it", async () => {
    const inbox = await mustCreateDocument(as.staff, { received_on: "2026-06-20" });
    const { error } = await as.staff.rpc("update_document", { p_id: inbox.id, p: {
      client_id: clientA, doc_type_id: await typeId(officeId, T.form16a), period_id: await periodId(officeId, "2025-26-Q4"),
    } });
    expect(error).toBeNull();
    expect(await expectedItem(clientA, T.form16a, "2025-26-Q4")).toMatchObject({ status: "received", received_on: "2026-06-20", completed_by_document_id: inbox.id });
  });

  it("re-classifying away unlinks: the old item returns to pending, the new one is received", async () => {
    const d = await doc(as.staff, T.bank, "2026-04", { received_on: "2026-05-05" });
    expect((await expectedItem(clientA, T.bank, "2026-04")).status).toBe("received");
    const { error } = await as.staff.rpc("update_document", { p_id: d.id, p: { period_id: await periodId(officeId, "2026-05") } });
    expect(error).toBeNull();
    expect(await expectedItem(clientA, T.bank, "2026-04")).toMatchObject({ status: "pending", received_on: null, completed_by_document_id: null });
    expect(await expectedItem(clientA, T.bank, "2026-05")).toMatchObject({ status: "received", received_on: "2026-05-05", completed_by_document_id: d.id });
  });

  it("archiving unlinks; unarchiving links again", async () => {
    const item = await expectedItem(clientA, T.bank, "2026-05");
    const d = item.completed_by_document_id!;
    expect((await as.manager.rpc("archive_document", { p_id: d, p_reason: "Wrong file" })).error).toBeNull();
    expect((await expectedItem(clientA, T.bank, "2026-05")).status).toBe("pending");
    expect((await documentRow(d)).expected_doc_id).toBeNull();
    expect((await as.manager.rpc("unarchive_document", { p_id: d })).error).toBeNull();
    expect(await expectedItem(clientA, T.bank, "2026-05")).toMatchObject({ status: "received", completed_by_document_id: d });
  });

  it("received on is recomputed from the documents that remain linked", async () => {
    const first = await doc(as.staff, T.bank, "2026-06", { received_on: "2026-07-01" });
    const second = await doc(as.staff, T.bank, "2026-06", { received_on: "2026-07-03" });
    expect(await expectedItem(clientA, T.bank, "2026-06")).toMatchObject({ status: "received", received_on: "2026-07-01", completed_by_document_id: first.id });
    expect((await documentRow(second.id)).expected_doc_id).toBe((await expectedItem(clientA, T.bank, "2026-06")).id);
    await as.manager.rpc("archive_document", { p_id: first.id, p_reason: "Duplicate" });
    expect(await expectedItem(clientA, T.bank, "2026-06")).toMatchObject({ status: "received", received_on: "2026-07-03", completed_by_document_id: second.id });
  });

  it("a document save adds no activity rows of its own for linking (03's row covers the save, AC-18)", async () => {
    const before = (await expectedActivity(officeId)).length;
    await doc(as.staff, T.salaryTds, "2026-06", { registration_id: reg.tan, received_on: "2026-07-01" });
    expect((await expectedActivity(officeId)).length).toBe(before);
  });
});

// ── Access (AC-17) ────────────────────────────────────────────────────────────
describe("visibility and write protection (AC-17)", () => {
  const visibleIds = async (who: SupabaseClient, client: string) => {
    const { data, error } = await who.from("expected_doc").select("id").eq("client_id", client);
    expect(error).toBeNull();
    return data!.length;
  };

  it("Admin, Manager and Staff see every client's items; Limited only clients they can see; other offices none", async () => {
    const aCount = (await expectedFor(clientA)).length;
    const bCount = (await expectedFor(clientB)).length;
    expect(aCount).toBeGreaterThan(0);
    expect(bCount).toBeGreaterThan(0);
    for (const k of ["admin", "manager", "staff"] as const) {
      expect(await visibleIds(as[k], clientA)).toBe(aCount);
      expect(await visibleIds(as[k], clientB)).toBe(bCount);
    }
    expect(await visibleIds(as.limited, clientA)).toBe(aCount); // incharge
    expect(await visibleIds(as.limited, clientB)).toBe(0);
    expect(await visibleIds(as.outsider, clientA)).toBe(0);
  });

  it("nobody can insert, update or delete expected documents directly", async () => {
    const item = await expectedItem(clientA, T.bank, "2026-04");
    const ins = await as.admin.from("expected_doc").insert({
      office_id: officeId, client_id: clientA, client_doc_type_id: item.client_doc_type_id, doc_type_id: item.doc_type_id,
      period_id: await periodId(officeId, "2026-02"), ask_on: "2026-03-01", overdue_from: "2026-03-07", status: "pending",
    });
    expect(ins.error?.message ?? "").toMatch(DENIED);
    for (const k of ["admin", "manager", "staff", "limited"] as const) {
      const upd = await as[k].from("expected_doc").update({ status: "waived", waived_code: "manual" }).eq("id", item.id).select("id");
      expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
      const del = await as[k].from("expected_doc").delete().eq("id", item.id).select("id");
      expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
    }
    expect((await expectedItem(clientA, T.bank, "2026-04")).status).toBe("pending");
  });

  it("no hard delete, even for the service role (only reset_test_office purges)", async () => {
    const item = await expectedItem(clientA, T.bank, "2026-04");
    const { error } = await adminClient().from("expected_doc").delete().eq("id", item.id);
    expect(error?.message ?? "").toMatch(/NO_DELETE|forbid|not allowed/i);
  });

  it("document.expected_doc_id is set by the database only", async () => {
    const item = await expectedItem(clientA, T.bank, "2026-04");
    const { data } = await as.staff.from("document").select("id").eq("client_id", clientA).is("expected_doc_id", null).limit(1).single();
    const upd = await as.staff.from("document").update({ expected_doc_id: item.id }).eq("id", data!.id).select("id");
    expect(upd.error?.message ?? "").toMatch(DENIED);
  });

  it("the test clock is Admin-only and refuses real offices", async () => {
    const staffRun = await as.staff.rpc("run_expected_generation", { p_as_of: "2026-07-01" });
    expect(staffRun.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    const realLike = await createCatalogueOffice("exp-not-test", { isTest: false, reset: false });
    const realAdmin = await createStaff(realLike, "exp-not-test-admin", "admin");
    const c = await signedInClient(realAdmin.email);
    const { error } = await c.rpc("run_expected_generation", { p_as_of: "2026-07-01" });
    expect(error?.message ?? "").toMatch(/NOT_TEST_OFFICE/);
    await retireStaff([realAdmin.id]);
  });

  it("a user cannot generate or read items of another office's client", async () => {
    await generateAsOf(as.outsider, "2026-07-01"); // runs only for the outsider's own office
    const { data } = await as.outsider.from("expected_doc").select("id").eq("office_id", officeId);
    expect(data ?? []).toEqual([]);
    const { error } = await as.outsider.rpc("waive_expected", { p_id: (await expectedItem(clientA, T.bank, "2026-04")).id, p_reason: "x" });
    expect(error?.message ?? "").toMatch(DENIED_OR_NOT_FOUND);
  });
});


// ── Step 4: the screens' query under RLS ─────────────────────────────────────
describe("Expected tab query (src/lib/expected, step 4)", () => {
  it("runs as the user under RLS and every row shapes into an item with a state", async () => {
    const { data, error } = await as.staff.from("expected_doc").select(EXPECTED_SELECT).eq("client_id", clientA);
    expect(error).toBeNull();
    const rows = (data ?? []) as unknown as RawExpected[];
    expect(rows.length).toBe((await expectedFor(clientA)).length);
    const { data: regs } = await as.staff.from("client_registration").select("kind, active").eq("client_id", clientA);
    const repeated = repeatedKinds(regs ?? []);
    expect(repeated.has("gstin")).toBe(true); // client A: two active GSTINs → shown on the rows
    const items = rows.map((r) => toItem(r, "2026-07-01", repeated));
    expect(items.every((i) => i.typeName && i.groupName && i.periodLabel && i.state.text)).toBe(true);
    expect(items.some((i) => i.registration !== null)).toBe(true);
    expect(items.filter((i) => i.registrationId && i.typeName === T.salaryTds).every((i) => i.registration === null)).toBe(true); // one TAN → not shown
    expect(items.some((i) => i.state.kind === "received" && /DOC-FY/.test(i.state.text))).toBe(true);
  });

  it("Limited gets its own clients' rows only", async () => {
    const mine = await as.limited.from("expected_doc").select(EXPECTED_SELECT).eq("client_id", clientA);
    expect(mine.error).toBeNull();
    expect((mine.data ?? []).length).toBeGreaterThan(0);
    const other = await as.limited.from("expected_doc").select(EXPECTED_SELECT).eq("client_id", clientB);
    expect(other.data ?? []).toEqual([]);
  });
});

// ── Date maths, month ends, leap year, FY roll-over (exp-clock office) ──────────
describe("schedule date maths and FY roll-over", () => {
  beforeAll(async () => {
    await generateAsOf(as.clockAdmin, "2026-03-15");
    clientD = (await mustInsertClient(as.clockAdmin, clockOffice, { name: "Clock client", client_type: "individual", incharge_id: u.clockAdmin.id })).id;
    await enable(as.clockAdmin, clientD, clockOffice, "Banking");
    for (const n of ["Loan statement / interest certificate", "Bank balance confirmation", "FD / interest certificates"]) {
      await setRow(as.clockAdmin, clientD, n, { state: "removed" });
    }
    // Asked on the 31st one month after, overdue on the 31st two months after (clamped to month ends).
    await setRow(as.clockAdmin, clientD, T.bank, { ask_after_months: 1, ask_day: 31, overdue_after_months: 2, overdue_day: 31 });
  }, 60_000);

  it("clamps day 31 to the month's last day, and an item is generated ON its ask date", async () => {
    await generateAsOf(as.clockAdmin, "2026-07-31");
    const rows = await expectedOf(clientD, T.bank);
    expect(rows.map((r) => [r.period.code, r.ask_on, r.overdue_from])).toEqual([
      ["2026-03", "2026-04-30", "2026-05-31"],
      ["2026-04", "2026-05-31", "2026-06-30"],
      ["2026-05", "2026-06-30", "2026-07-31"],
      ["2026-06", "2026-07-31", "2026-08-31"], // ask date = today → generated
    ]);
  });

  it("does not create the next financial year before 1 February", async () => {
    await generateAsOf(as.clockAdmin, "2027-01-31");
    const { data } = await adminClient().from("financial_year").select("code").eq("office_id", clockOffice).eq("code", "2027-28");
    expect(data ?? []).toEqual([]);
  });

  it("creates the next financial year and its 17 periods from 1 February, as a system activity row", async () => {
    await generateAsOf(as.clockAdmin, "2027-02-01");
    const { data: fy } = await adminClient().from("financial_year").select("id").eq("office_id", clockOffice).eq("code", "2027-28").single();
    expect(fy).not.toBeNull();
    const { count } = await adminClient().from("period").select("id", { count: "exact", head: true }).eq("financial_year_id", fy!.id);
    expect(count).toBe(17);
    const { data: act } = await adminClient().from("activity").select("actor_id").eq("office_id", clockOffice).eq("action", "financial_year.added");
    expect((act ?? []).some((a) => a.actor_id === null)).toBe(true);
  });

  it("crosses 31 Mar / 1 Apr and handles 29 February in a leap year", async () => {
    await generateAsOf(as.clockAdmin, "2028-03-01");
    expect(await expectedItem(clientD, T.bank, "2027-03")).toMatchObject({ ask_on: "2027-04-30", overdue_from: "2027-05-31" });
    expect(await expectedItem(clientD, T.bank, "2027-12")).toMatchObject({ ask_on: "2028-01-31", overdue_from: "2028-02-29" });
    expect(await expectedItem(clientD, T.bank, "2028-01")).toMatchObject({ ask_on: "2028-02-29", overdue_from: "2028-03-31" });
    const codes = (await expectedOf(clientD, T.bank)).map((r) => r.period.code);
    expect(codes[codes.length - 1]).toBe("2028-01"); // Feb 2028 is asked on 31 Mar
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("offset 0: a yearly type asked in the period's own last month", async () => {
    const { data: t, error } = await as.clockAdmin.from("doc_type").insert({
      office_id: clockOffice, doc_group_id: await groupId(clockOffice, "Banking"), code: "exp_offset_zero", name: "Exp offset zero",
      period_kind: "year", default_frequency: "yearly", source: "client",
      ask_after_months: 0, ask_day: 15, overdue_after_months: 0, overdue_day: 31,
    }).select("id").single();
    expect(error).toBeNull();
    expect((await as.clockAdmin.rpc("add_client_doc_type", { p_client_id: clientD, p_doc_type_id: t!.id })).error).toBeNull();
    await generateAsOf(as.clockAdmin, "2028-03-20");
    // FY 2027-28 ends 31 Mar 2028: asked 15 Mar 2028, overdue from 31 Mar 2028.
    expect(await expectedItem(clientD, "Exp offset zero", "2027-28")).toMatchObject({ ask_on: "2028-03-15", overdue_from: "2028-03-31" });
  });

  // Step 3 proof: src/lib/expected/schedule.ts computes exactly the dates the database stored, for every item
  // generated in both offices (month ends, 31st clamping, 29 Feb, FY crossing, offset 0, monthly/quarterly/yearly).
  it("schedule.ts gives the same ask / overdue-from dates as the database for every generated item", async () => {
    const { data, error } = await adminClient().from("expected_doc")
      .select("ask_on, overdue_from, period:period_id(code, end_date), row:client_doc_type_id(ask_after_months, ask_day, overdue_after_months, overdue_day)")
      .in("office_id", [officeId, clockOffice]);
    expect(error).toBeNull();
    type R = { ask_on: string; overdue_from: string; period: { code: string; end_date: string };
      row: { ask_after_months: number; ask_day: number; overdue_after_months: number; overdue_day: number } };
    const rows = (data ?? []) as unknown as R[];
    expect(rows.length).toBeGreaterThan(20);
    const mismatches = rows.filter((r) => {
      const d = scheduleDates(r.period.end_date, {
        askAfterMonths: r.row.ask_after_months, askDay: r.row.ask_day,
        overdueAfterMonths: r.row.overdue_after_months, overdueDay: r.row.overdue_day,
      });
      return d.askOn !== r.ask_on || d.overdueFrom !== r.overdue_from;
    }).map((r) => `${r.period.code}: db ${r.ask_on}/${r.overdue_from}`);
    expect(mismatches).toEqual([]);
  });
});

// ── The daily job ─────────────────────────────────────────────────────────────
describe("daily job (AC-1)", () => {
  it("is registered with pg_cron at 00:15 IST (18:45 UTC)", async () => {
    const { data, error } = await adminClient().rpc("expected_job_info");
    expect(error).toBeNull();
    expect(data).toMatchObject({ jobname: "expected-docs-daily", schedule: "45 18 * * *", active: true });
  });

  it("its info function is not callable by app users", async () => {
    const { error } = await as.admin.rpc("expected_job_info");
    expect(error?.message ?? "").toMatch(/permission denied|not find|ROLE_REQUIRED/i);
  });
});
