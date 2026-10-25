import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, resetTestOffice } from "../support/catalogue";
import { createDocumentOffice, typeId } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf } from "../support/expected";

// Feature 10 — client upload links, plan step 1: the schema (spec "Data model changes").
// Requests and items are visible iff the user can see the client; no app role writes them directly; link_attempt
// is never visible to app roles; the test-office purge removes all three tables.
// Rows are created here with the service role because the staff functions arrive in step 2.

type Who = "admin" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let staffClient: string;   // incharge = staff (Limited can't see it)
let limitedClient: string; // incharge = limited
let requestId: string;
let limitedRequestId: string;

const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const admin = () => adminClient();

async function insertRequest(client: string, createdBy: string) {
  const { data, error } = await admin().from("upload_request").insert({
    office_id: officeId, client_id: client, token_hash: hash(), created_by: createdBy,
    expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-links");
  u.admin = await createStaff(officeId, "ul-admin", "admin");
  u.staff = await createStaff(officeId, "ul-staff", "staff");
  u.limited = await createStaff(officeId, "ul-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  staffClient = await bankOnlyClient(as.staff, officeId, { name: "Upload A", incharge_id: u.staff.id });
  limitedClient = await bankOnlyClient(as.staff, officeId, { name: "Upload L", incharge_id: u.limited.id });
  await generateAsOf(as.admin, "2026-05-15");
  requestId = await insertRequest(staffClient, u.staff.id);
  limitedRequestId = await insertRequest(limitedClient, u.limited.id);
  const item = await expectedItem(staffClient, T.bank, "2026-03");
  const { error: e1 } = await admin().from("upload_request_item").insert({
    office_id: officeId, request_id: requestId, kind: "scheduled", expected_doc_id: item.id,
  });
  if (e1) throw e1;
  const { error: e2 } = await admin().from("upload_request_item").insert({
    office_id: officeId, request_id: requestId, kind: "ad_hoc", doc_type_id: await typeId(officeId, T.bank),
    needed_by: "2026-05-30", note: "for the new office lease",
  });
  if (e2) throw e2;
  const { error: e3 } = await admin().from("link_attempt").insert({ office_id: officeId, ip_hash: hash(), kind: "lookup_failed" });
  if (e3) throw e3;
}, 180_000);

afterAll(async () => {
  await retireStaff([u.staff, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("visibility follows the client (spec: RLS)", () => {
  it("staff and admin see the request and its items; Limited sees only their own client's request", async () => {
    for (const who of ["admin", "staff"] as const) {
      const { data } = await as[who].from("upload_request").select("id").in("id", [requestId, limitedRequestId]);
      expect(data?.map((r) => r.id).sort()).toEqual([requestId, limitedRequestId].sort());
      const { data: items } = await as[who].from("upload_request_item").select("id").eq("request_id", requestId);
      expect(items).toHaveLength(2);
    }
    const { data: lim } = await as.limited.from("upload_request").select("id").in("id", [requestId, limitedRequestId]);
    expect(lim?.map((r) => r.id)).toEqual([limitedRequestId]);
    const { data: limItems } = await as.limited.from("upload_request_item").select("id").eq("request_id", requestId);
    expect(limItems).toEqual([]);
  });

  it("the token hash is never selectable by app roles", async () => {
    const { error } = await as.admin.from("upload_request").select("token_hash").eq("id", requestId);
    expect(error?.message ?? "").toMatch(/permission denied/i);
  });

  it("link_attempt is invisible to every app role", async () => {
    for (const who of ["admin", "staff", "limited"] as const) {
      const { data, error } = await as[who].from("link_attempt").select("id");
      expect(error?.message ?? (data?.length === 0 ? "empty" : "rows")).toMatch(/permission denied|empty/i);
    }
  });
});

describe("no direct app writes (functions only)", () => {
  it("authenticated users cannot insert, update or delete requests or items", async () => {
    const ins = await as.admin.from("upload_request").insert({
      office_id: officeId, client_id: staffClient, token_hash: hash(), created_by: u.admin.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(ins.error?.message ?? "").toMatch(DENIED);
    const upd = await as.admin.from("upload_request").update({ revoked_at: new Date().toISOString(), revoked_by: u.admin.id }).eq("id", requestId).select("id");
    expect(upd.error?.message ?? (upd.data?.length === 0 ? "permission denied" : "")).toMatch(DENIED);
    const del = await as.admin.from("upload_request_item").delete().eq("request_id", requestId).select("id");
    expect(del.error?.message ?? (del.data?.length === 0 ? "permission denied" : "")).toMatch(DENIED);
  });

  it("even the service role cannot change a request outside 10's functions, or delete one outside the test purge", async () => {
    const upd = await admin().from("upload_request").update({ files_count: 5 }).eq("id", requestId);
    expect(upd.error?.message ?? "").toMatch(/IMMUTABLE/);
    const del = await admin().from("upload_request").delete().eq("id", requestId);
    expect(del.error?.message ?? "").toMatch(/NO_DELETE/);
  });
});

describe("constraints", () => {
  it("a scheduled item needs an expected document and no ad-hoc fields; an ad-hoc item needs a type", async () => {
    const bad1 = await admin().from("upload_request_item").insert({ office_id: officeId, request_id: requestId, kind: "scheduled" });
    expect(bad1.error?.message ?? "").toMatch(/upload_request_item_kind/);
    const bad2 = await admin().from("upload_request_item").insert({ office_id: officeId, request_id: requestId, kind: "ad_hoc" });
    expect(bad2.error?.message ?? "").toMatch(/upload_request_item_kind/);
  });

  it("notes are 1–200 characters; the token hash is 64 hex characters", async () => {
    const long = await admin().from("upload_request_item").insert({
      office_id: officeId, request_id: requestId, kind: "ad_hoc", doc_type_id: await typeId(officeId, T.bank), note: "x".repeat(201),
    });
    expect(long.error?.message ?? "").toMatch(/check/i);
    const badHash = await admin().from("upload_request").insert({
      office_id: officeId, client_id: staffClient, token_hash: "not-a-hash", created_by: u.staff.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(badHash.error?.message ?? "").toMatch(/check/i);
  });

  it("documents get a nullable upload_request_item_id", async () => {
    const { error } = await admin().from("document").select("upload_request_item_id").limit(1);
    expect(error).toBeNull();
  });
});

describe("test-office purge", () => {
  it("reset_test_office removes requests, items and attempts", async () => {
    await resetTestOffice(officeId);
    for (const t of ["upload_request", "upload_request_item", "link_attempt"]) {
      const { count, error } = await admin().from(t).select("id", { count: "exact", head: true }).eq("office_id", officeId);
      expect(error).toBeNull();
      expect(count).toBe(0);
    }
  });
});
