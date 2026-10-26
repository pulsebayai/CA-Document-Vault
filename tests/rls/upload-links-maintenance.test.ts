import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, createSoftCopy, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";
import { removeOrphanObjects } from "@/lib/documents/storage-core";

// Feature 10 step 11 — maintenance (migration H): link_attempt keeps 7 days; orphan_objects lists stored files no
// document version points at (service role only); the sweep never removes a file younger than 24 hours.

let officeId: string;
let staff: { id: string; email: string };
let adminUser: { id: string; email: string };
let as: SupabaseClient;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const admin = () => adminClient();

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-maint");
  staff = await createStaff(officeId, "umt-staff", "staff");
  adminUser = await createStaff(officeId, "umt-admin", "admin");
  as = await signedInClient(staff.email);
}, 120_000);
afterAll(async () => { await retireStaff([staff.id, adminUser.id]); });

describe("link_attempt retention (spec Privacy: 7 days)", () => {
  it("purge_link_attempts removes rows older than 7 days and keeps newer ones", async () => {
    const ip = sha(`maint-${Date.now()}`);
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 6 * 86_400_000).toISOString();
    const { error } = await admin().from("link_attempt").insert([
      { ip_hash: ip, kind: "lookup_failed", at: old }, { ip_hash: ip, kind: "lookup_failed", at: recent }]);
    if (error) throw error;
    const { data: n, error: e } = await admin().rpc("purge_link_attempts");
    if (e) throw e;
    expect(n).toBeGreaterThanOrEqual(1);
    const { data: left } = await admin().from("link_attempt").select("at").eq("ip_hash", ip);
    expect((left ?? []).map((r) => Date.parse(r.at as string))).toEqual([Date.parse(recent)]);
  });
});

describe("orphan objects (spec Reliability; 03's orphans too)", () => {
  it("lists an unregistered upload and never a registered version; staff can't call it", async () => {
    await generateAsOf(await signedInClient(adminUser.email), "2026-03-15");
    const client = await bankOnlyClient(as, officeId, { name: "Maintenance Client", incharge_id: staff.id });
    const filed = await createSoftCopy(as, officeId, { client_id: client, doc_type_id: await typeId(officeId, T.bank) });
    const loose = await uploadObject(officeId, "pdf");
    const { data, error } = await admin().rpc("orphan_objects", { p_older_than_hours: 0, p_limit: 1000, p_office: officeId });
    if (error) throw error;
    const names = (data as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain(loose.path);
    expect(names).not.toContain(filed.object.path);
    const denied = await as.rpc("orphan_objects", { p_older_than_hours: 0, p_limit: 10 });
    expect(denied.error?.message ?? "").toMatch(/permission denied|not find|does not exist/i);
  });

  it("the sweep keeps files younger than 24 hours, whatever it is asked", async () => {
    const loose = await uploadObject(officeId, "pdf");
    await removeOrphanObjects(admin(), 0, 1000); // asks for 0 h: clamped to 24 h
    const { data } = await admin().storage.from("documents").info(loose.path);
    expect(data?.size).toBeGreaterThan(0);
  });
});
