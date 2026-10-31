import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { bankOnlyClient } from "../support/expected";
import {
  FAKE_CT, FAKE_CT_2, archiveDsc, custodyLog, dscActivity, dscRow, logCustody, mustSaveDsc, newDsc, saveDsc, setRemindDays,
  unarchiveDsc,
} from "../support/dsc";

// Feature 14 — DSC records, custody, settings (spec AC-1 … AC-5, AC-8 … AC-10, AC-12, T1, T4; NFR Privacy).
// Written before the migration (plan step 1). Contract: tests/support/dsc.ts.

type Who = "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let client: string, other: string;
const HOLDER = "Ravi Kumar Holder";
const PERSON = "Anitha Courier";

const save = (who: SupabaseClient, extra: Parameters<typeof newDsc>[1] = {}, on = client) => mustSaveDsc(who, newDsc(on, { holder_name: HOLDER, ...extra }));
const err = (r: { error: { message: string } | null }) => r.error?.message ?? "";

beforeAll(async () => {
  officeId = await createDocumentOffice("dsc");
  u.manager = await createStaff(officeId, "dsc-manager", "manager");
  u.staff = await createStaff(officeId, "dsc-staff", "staff");
  u.limited = await createStaff(officeId, "dsc-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  client = await bankOnlyClient(as.staff, officeId, { name: "DSC client", incharge_id: u.limited.id }); // Limited sees it
  other = await bankOnlyClient(as.staff, officeId, { name: "DSC other", incharge_id: u.staff.id }); // Limited doesn't
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
});

describe("Add and edit (AC-2, AC-4, AC-6, T4)", () => {
  it("Staff adds a DSC: the row, who set the password, one dsc.created row with IDs only", async () => {
    const id = await save(as.staff, { token_note: "Token 77", issuer: "Capricorn", dsc_class: "dgft" });
    const row = await dscRow(id);
    expect(row).toMatchObject({
      office_id: officeId, client_id: client, holder_name: HOLDER, expires_on: "2027-03-12", dsc_class: "dgft",
      issuer: "Capricorn", token_note: "Token 77", password_ct: FAKE_CT, password_set_by: u.staff.id, created_by: u.staff.id,
      archived_at: null,
    });
    expect(row.password_set_at).not.toBeNull();
    const act = await dscActivity(officeId, id);
    expect(act.map((a) => [a.action, a.actor_id, a.entity_type])).toEqual([["dsc.created", u.staff.id, "dsc"]]);
    expect(act[0].data).toEqual({ client_id: client });
  });

  it("Manager can add; several DSCs per client (Q5)", async () => {
    await save(as.manager, { holder_name: "Second Holder" });
    await save(as.manager, { holder_name: "Third Holder" });
    const { data } = await as.staff.from("dsc").select("id").eq("client_id", client);
    expect((data ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("Limited can't add or edit, even for a client they see", async () => {
    expect(err(await saveDsc(as.limited, newDsc(client)))).toMatch(/ROLE_REQUIRED|permission|row-level/i);
    const id = await save(as.staff);
    expect(err(await saveDsc(as.limited, { id, holder_name: "Changed" }))).toMatch(/ROLE_REQUIRED|permission|row-level/i);
    expect((await dscRow(id)).holder_name).toBe(HOLDER);
  });

  it("the password must arrive encrypted: a plain value, a missing one on create, or a malformed one is refused", async () => {
    expect(err(await saveDsc(as.staff, newDsc(client, { password_ct: "1234" })))).toMatch(/DSC_BAD_CIPHERTEXT/);
    expect(err(await saveDsc(as.staff, newDsc(client, { password_ct: "ktest.short.x.y" })))).toMatch(/DSC_BAD_CIPHERTEXT/);
    expect(err(await saveDsc(as.staff, newDsc(client, { password_ct: null })))).toMatch(/DSC_PASSWORD_REQUIRED/);
  });

  it("the database checks the limits again (holder 1–120, expiry required, note ≤ 200, issuer ≤ 80, class enum)", async () => {
    expect(err(await saveDsc(as.staff, newDsc(client, { holder_name: " " })))).not.toBe("");
    expect(err(await saveDsc(as.staff, newDsc(client, { holder_name: "x".repeat(121) })))).not.toBe("");
    expect(err(await saveDsc(as.staff, { ...newDsc(client), expires_on: undefined }))).not.toBe("");
    expect(err(await saveDsc(as.staff, newDsc(client, { token_note: "x".repeat(201) })))).not.toBe("");
    expect(err(await saveDsc(as.staff, newDsc(client, { issuer: "x".repeat(81) })))).not.toBe("");
    expect(err(await saveDsc(as.staff, newDsc(client, { dsc_class: "class2" as never })))).not.toBe("");
  });

  it("an edit lists the changed fields; a renewal is an expiry change; the password stays unless sent", async () => {
    const id = await save(as.staff);
    await mustSaveDsc(as.manager, { id, holder_name: HOLDER, expires_on: "2029-03-12", issuer: "VSign", dsc_class: "class3", token_note: null });
    const row = await dscRow(id);
    expect(row).toMatchObject({ expires_on: "2029-03-12", issuer: "VSign", password_ct: FAKE_CT, password_set_by: u.staff.id, updated_by: u.manager.id });
    const act = (await dscActivity(officeId, id)).filter((a) => a.action === "dsc.updated");
    expect(act).toHaveLength(1);
    expect(act[0].data).toEqual({ client_id: client, fields: ["expires_on", "issuer"] });
  });

  it("Change password: a new ciphertext, who set it, one dsc.password_changed row and no dsc.updated", async () => {
    const id = await save(as.staff);
    await mustSaveDsc(as.manager, { id, holder_name: HOLDER, expires_on: "2027-03-12", dsc_class: "class3", issuer: "eMudhra", password_ct: FAKE_CT_2 });
    expect(await dscRow(id)).toMatchObject({ password_ct: FAKE_CT_2, password_set_by: u.manager.id });
    expect((await dscActivity(officeId, id)).map((a) => a.action)).toEqual(["dsc.created", "dsc.password_changed"]);
  });

  it("a DSC can't move to another client", async () => {
    const id = await save(as.staff);
    expect(err(await saveDsc(as.staff, { id, client_id: other, holder_name: HOLDER, expires_on: "2027-03-12" }))).toMatch(/DSC_CLIENT_FIXED/);
    expect((await dscRow(id)).client_id).toBe(client);
  });

  it("an archived client gets no new DSC", async () => {
    const gone = await bankOnlyClient(as.staff, officeId, { name: "DSC archived client", incharge_id: u.staff.id });
    const { error } = await as.manager.from("client").update({ archived_at: new Date().toISOString(), archive_reason: "Test" }).eq("id", gone).select("id");
    expect(error).toBeNull();
    expect(err(await saveDsc(as.staff, newDsc(gone)))).toMatch(/CLIENT_ARCHIVED/);
  });
});

describe("Reads and direct writes (AC-1, AC-6, T1)", () => {
  it("the password column can't be selected by any role; the other columns can", async () => {
    const id = await save(as.staff);
    for (const who of [as.manager, as.staff, as.limited]) {
      const { error } = await who.from("dsc").select("password_ct").eq("id", id);
      expect(error?.message ?? "").toMatch(/permission denied/i);
    }
    const { data, error } = await as.staff.from("dsc").select("id, holder_name, expires_on, password_set_at").eq("id", id).single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ id, holder_name: HOLDER });
  });

  it("Limited sees DSCs of their clients only", async () => {
    const mine = await save(as.staff);
    const theirs = await save(as.staff, {}, other);
    const { data } = await as.limited.from("dsc").select("id").in("id", [mine, theirs]);
    expect((data ?? []).map((r) => r.id)).toEqual([mine]);
  });

  it("no direct insert, update or delete for any role (writes only through the dsc_* functions)", async () => {
    const id = await save(as.staff);
    for (const who of [as.manager, as.staff]) {
      const ins = await who.from("dsc").insert({ office_id: officeId, client_id: client, holder_name: "Direct", expires_on: "2027-01-01", password_ct: FAKE_CT }).select("id");
      expect(ins.error || (ins.data ?? []).length === 0).toBeTruthy();
      const upd = await who.from("dsc").update({ holder_name: "Direct" }).eq("id", id).select("id");
      expect(upd.error || (upd.data ?? []).length === 0).toBeTruthy();
      const del = await who.from("dsc").delete().eq("id", id).select("id");
      expect(del.error || (del.data ?? []).length === 0).toBeTruthy();
      const cus = await who.from("dsc_custody").insert({ office_id: officeId, dsc_id: id, direction: "out", person_name: "x", on_date: "2026-10-01", actor_id: u.staff.id }).select("id");
      expect(cus.error || (cus.data ?? []).length === 0).toBeTruthy();
    }
    expect((await dscRow(id)).holder_name).toBe(HOLDER);
  });
});

describe("Archive (AC-5, T4)", () => {
  it("Admin/Manager archive with a reason and unarchive; Staff and Limited can't", async () => {
    const id = await save(as.staff);
    expect(err(await archiveDsc(as.staff, id, "Closed"))).toMatch(/ROLE_REQUIRED|permission/i);
    expect(err(await archiveDsc(as.limited, id, "Closed"))).toMatch(/ROLE_REQUIRED|permission/i);
    expect(err(await archiveDsc(as.manager, id, " "))).toMatch(/REASON_REQUIRED/);
    expect((await archiveDsc(as.manager, id, "Client closed")).error).toBeNull();
    expect(await dscRow(id)).toMatchObject({ archived_by: u.manager.id, archive_reason: "Client closed" });
    expect(err(await saveDsc(as.staff, { id, holder_name: HOLDER, expires_on: "2030-01-01" }))).toMatch(/DSC_ARCHIVED/);
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: PERSON, on_date: "2026-10-01" }))).toMatch(/DSC_ARCHIVED/);
    expect(err(await unarchiveDsc(as.staff, id))).toMatch(/ROLE_REQUIRED|permission/i);
    expect((await unarchiveDsc(as.manager, id)).error).toBeNull();
    expect(await dscRow(id)).toMatchObject({ archived_at: null, archived_by: null, archive_reason: null });
    expect((await dscActivity(officeId, id)).map((a) => a.action)).toEqual(["dsc.created", "dsc.archived", "dsc.unarchived"]);
  });
});

describe("Custody (AC-8, AC-9)", () => {
  it("out and in alternate; the record is re-used and keeps its history", async () => {
    const id = await save(as.staff);
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "in", person_name: PERSON, on_date: "2026-10-01" }))).toMatch(/DSC_NOT_OUT/);
    expect((await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: PERSON, on_date: "2026-10-02", note: "For GST filing" })).error).toBeNull();
    expect(err(await logCustody(as.manager, { dsc_id: id, direction: "out", person_name: "Someone", on_date: "2026-10-03" }))).toMatch(/DSC_ALREADY_OUT/);
    expect((await logCustody(as.manager, { dsc_id: id, direction: "in", person_name: PERSON, on_date: "2026-10-09" })).error).toBeNull();
    expect((await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: "Client director", on_date: "2026-10-20" })).error).toBeNull();
    const log = await custodyLog(id);
    expect(log.map((l) => [l.direction, l.person_name, l.on_date, l.actor_id])).toEqual([
      ["out", PERSON, "2026-10-02", u.staff.id], ["in", PERSON, "2026-10-09", u.manager.id], ["out", "Client director", "2026-10-20", u.staff.id],
    ]);
    expect(log[0].note).toBe("For GST filing");
    expect((await dscActivity(officeId, id)).map((a) => a.action)).toEqual(["dsc.created", "dsc.given_out", "dsc.received_back", "dsc.given_out"]);
  });

  it("refuses a name outside 1–120, a note over 200, and a date in the future (office date)", async () => {
    const id = await save(as.staff);
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: " ", on_date: "2026-10-01" }))).not.toBe("");
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: "x".repeat(121), on_date: "2026-10-01" }))).not.toBe("");
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: "R", on_date: "2026-10-01", note: "x".repeat(201) }))).not.toBe("");
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: "R", on_date: "2099-01-01" }))).toMatch(/DATE_IN_FUTURE/);
  });

  it("Limited logs moves for their clients only (T4)", async () => {
    const mine = await save(as.staff);
    const theirs = await save(as.staff, {}, other);
    expect((await logCustody(as.limited, { dsc_id: mine, direction: "out", person_name: PERSON, on_date: "2026-10-01" })).error).toBeNull();
    expect(err(await logCustody(as.limited, { dsc_id: theirs, direction: "out", person_name: PERSON, on_date: "2026-10-01" }))).toMatch(/NOT_FOUND|permission/i);
    expect(await custodyLog(theirs)).toEqual([]);
  });

  it("Limited reads the custody log of their clients only", async () => {
    const theirs = await save(as.staff, {}, other);
    await logCustody(as.staff, { dsc_id: theirs, direction: "out", person_name: PERSON, on_date: "2026-10-01" });
    const { data } = await as.limited.from("dsc_custody").select("id").eq("dsc_id", theirs);
    expect(data ?? []).toEqual([]);
    const { data: staffSees } = await as.staff.from("dsc_custody").select("id").eq("dsc_id", theirs);
    expect((staffSees ?? []).length).toBe(1);
  });
});

describe("Remind days (AC-10)", () => {
  it("Staff+ set 1–180; Limited can't; logged on the client", async () => {
    expect((await setRemindDays(as.staff, client, 45)).error).toBeNull();
    const { data } = await adminClient().from("client_dsc_setting").select("remind_days").eq("client_id", client).single();
    expect(data?.remind_days).toBe(45);
    expect((await setRemindDays(as.manager, client, 30)).error).toBeNull();
    for (const d of [0, 181]) expect(err(await setRemindDays(as.staff, client, d))).not.toBe("");
    expect(err(await setRemindDays(as.limited, client, 10))).toMatch(/ROLE_REQUIRED|permission/i);
    const act = (await dscActivity(officeId, client)).filter((a) => a.action === "dsc.remind_days_set");
    expect(act.map((a) => a.data)).toEqual([{ client_id: client, remind_days: 45 }, { client_id: client, remind_days: 30 }]);
  });
});

describe("Privacy (AC-12, NFR)", () => {
  it("no DSC activity row carries the holder name, a custody name, a note or the ciphertext", async () => {
    const { data } = await adminClient().from("activity").select("action, data").eq("office_id", officeId).like("action", "dsc.%");
    expect((data ?? []).length).toBeGreaterThan(5);
    const text = JSON.stringify(data);
    for (const s of [HOLDER, PERSON, "Client director", "For GST filing", "Token 77", FAKE_CT, FAKE_CT_2, "ktest."]) expect(text).not.toContain(s);
  });
});

describe("Step 10 review fixes", () => {
  it("I-1: a custody move can't be dated before the previous move", async () => {
    const id = await save(as.staff);
    expect((await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: PERSON, on_date: "2026-10-20" })).error).toBeNull();
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "in", person_name: PERSON, on_date: "2026-10-05" }))).toMatch(/DATE_BEFORE_LAST_MOVE/);
    expect((await logCustody(as.staff, { dsc_id: id, direction: "in", person_name: PERSON, on_date: "2026-10-20" })).error).toBeNull(); // same day is fine
  });

  it("I-4: a DSC that is out can't be archived until it is received back", async () => {
    const id = await save(as.staff);
    await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: PERSON, on_date: "2026-10-01" });
    expect(err(await archiveDsc(as.manager, id, "Closed"))).toMatch(/DSC_OUT/);
    await logCustody(as.staff, { dsc_id: id, direction: "in", person_name: PERSON, on_date: "2026-10-02" });
    expect((await archiveDsc(as.manager, id, "Closed")).error).toBeNull();
  });

  it("I-3: an archived client's DSCs are read-only (edit, password, custody, remind days refused; reveal still works)", async () => {
    const gone = await bankOnlyClient(as.staff, officeId, { name: "DSC client to archive", incharge_id: u.staff.id });
    const id = await save(as.staff, {}, gone);
    const r = await as.manager.from("client").update({ archived_at: new Date().toISOString(), archive_reason: "Test" }).eq("id", gone).select("id");
    expect(r.error).toBeNull();
    expect(err(await saveDsc(as.staff, { id, holder_name: "Changed", expires_on: "2030-01-01" }))).toMatch(/CLIENT_ARCHIVED/);
    expect(err(await saveDsc(as.staff, { id, password_ct: FAKE_CT_2 }))).toMatch(/CLIENT_ARCHIVED/);
    expect(err(await logCustody(as.staff, { dsc_id: id, direction: "out", person_name: PERSON, on_date: "2026-10-01" }))).toMatch(/CLIENT_ARCHIVED/);
    expect(err(await setRemindDays(as.staff, gone, 45))).toMatch(/CLIENT_ARCHIVED/);
    expect((await dscRow(id)).holder_name).toBe(HOLDER);
    expect((await as.staff.rpc("dsc_reveal", { p_id: id })).data).toBe(FAKE_CT);
  });
});
