import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { bankOnlyClient } from "../support/expected";
import { FAKE_CT, FAKE_CT_2, archiveDsc, dscActivity, mustSaveDsc, newDsc, revealDsc } from "../support/dsc";

// Feature 14 — reveal (spec AC-7, T4, T5, FR dsc_reveal; NFR Security: the ciphertext only through dsc_reveal).
// Written before the migration (plan step 1). The database returns the ciphertext; only the server decrypts it.

type Who = "admin" | "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who | "outsider", { id: string; email: string }>;
const as = {} as Record<Who | "outsider", SupabaseClient>;
let client: string, other: string;

const reveals = async (id: string) => (await dscActivity(officeId, id)).filter((a) => a.action === "dsc.password_revealed");

beforeAll(async () => {
  officeId = await createDocumentOffice("dsc-reveal");
  const otherOffice = await createDocumentOffice("dsc-reveal-other");
  for (const r of ["admin", "manager", "staff", "limited"] as Who[]) u[r] = await createStaff(officeId, `dsr-${r}`, r);
  u.outsider = await createStaff(otherOffice, "dsr-outsider", "admin");
  for (const k of Object.keys(u) as Array<Who | "outsider">) as[k] = await signedInClient(u[k].email);
  client = await bankOnlyClient(as.staff, officeId, { name: "Reveal client", incharge_id: u.limited.id });
  other = await bankOnlyClient(as.staff, officeId, { name: "Reveal other", incharge_id: u.staff.id });
}, 120_000);

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("dsc_reveal (AC-7, T5)", () => {
  it("Admin, Manager and Staff get the stored ciphertext; each call writes its own activity row first", async () => {
    const id = await mustSaveDsc(as.staff, newDsc(client));
    for (const who of ["admin", "manager", "staff"] as const) {
      const { data, error } = await revealDsc(as[who], id);
      expect(error).toBeNull();
      expect(data).toBe(FAKE_CT);
    }
    await revealDsc(as.staff, id);
    const rows = await reveals(id);
    expect(rows.map((r) => r.actor_id)).toEqual([u.admin.id, u.manager.id, u.staff.id, u.staff.id]);
    for (const r of rows) expect(r).toMatchObject({ entity_type: "dsc", entity_id: id, data: { client_id: client } });
  });

  it("returns the current password after a change", async () => {
    const id = await mustSaveDsc(as.staff, newDsc(client));
    await mustSaveDsc(as.staff, { id, holder_name: "Test Holder", expires_on: "2027-03-12", dsc_class: "class3", issuer: "eMudhra", password_ct: FAKE_CT_2 });
    expect((await revealDsc(as.staff, id)).data).toBe(FAKE_CT_2);
  });

  it("Limited never reveals, even for a client they see; nothing is logged", async () => {
    const id = await mustSaveDsc(as.staff, newDsc(client));
    const { data, error } = await revealDsc(as.limited, id);
    expect(data).toBeNull();
    expect(error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    expect(await reveals(id)).toEqual([]);
  });

  it("an archived DSC is refused (unarchive first); nothing is logged", async () => {
    const id = await mustSaveDsc(as.staff, newDsc(other));
    expect((await archiveDsc(as.manager, id, "No longer managed")).error).toBeNull();
    const { data, error } = await revealDsc(as.manager, id);
    expect(data).toBeNull();
    expect(error?.message ?? "").toMatch(/DSC_ARCHIVED/);
    expect(await reveals(id)).toEqual([]);
  });

  it("another office's staff (even an Admin) get NOT_FOUND, with no log row; an unknown ID too", async () => {
    const id = await mustSaveDsc(as.staff, newDsc(client));
    const { data, error } = await revealDsc(as.outsider, id);
    expect(data).toBeNull();
    expect(error?.message ?? "").toMatch(/NOT_FOUND/);
    expect(await reveals(id)).toEqual([]);
    expect((await revealDsc(as.staff, "00000000-0000-4000-8000-000000000000")).error?.message ?? "").toMatch(/NOT_FOUND/);
  });

  it("a deactivated staff member's session can't reveal", async () => {
    const gone = await createStaff(officeId, "dsr-gone", "staff");
    const goneAs = await signedInClient(gone.email);
    const id = await mustSaveDsc(as.staff, newDsc(client));
    await retireStaff([gone.id]);
    const { data } = await revealDsc(goneAs, id);
    expect(data).toBeNull();
    expect(await reveals(id)).toEqual([]);
  });

  it("anonymous callers can't execute it", async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const id = await mustSaveDsc(as.staff, newDsc(client));
    const { data, error } = await anon.rpc("dsc_reveal", { p_id: id });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("the ciphertext is reachable only through dsc_reveal: not by select, not in dsc_due", async () => {
    const id = await mustSaveDsc(as.staff, newDsc(client, { expires_on: "2020-01-01" }));
    const sel = await as.admin.from("dsc").select("*").eq("id", id);
    expect(sel.error?.message ?? JSON.stringify(sel.data)).not.toContain(FAKE_CT);
    const due = await as.admin.rpc("dsc_due", { p_scope: "everyone" });
    expect(JSON.stringify(due.data ?? due.error)).not.toContain("ktest.");
  });
});
