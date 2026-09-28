import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { ALLOWED_MIME, BUCKET, MAX_BYTES, TINY, createDocumentOffice, objectPath, uploadObject } from "../support/documents";

// Feature 03 — files are never public (spec AC-13, AC-14; plan step 1). The signed-URL round trip
// (issue → upload → register → view/download → expiry) is added in plan step 4 with the storage module.

let officeId: string;
let staff: { id: string; email: string };
let asStaff: SupabaseClient;
let anon: SupabaseClient;
let existing: { path: string };

beforeAll(async () => {
  officeId = await createDocumentOffice("storage");
  staff = await createStaff(officeId, "storage-staff", "staff");
  asStaff = await signedInClient(staff.email);
  anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  existing = await uploadObject(officeId, "pdf");
});

afterAll(async () => {
  if (staff) await retireStaff([staff.id]);
});

describe("bucket 'documents' (AC-2, AC-13)", () => {
  it("is private, capped at 25 MB, and accepts only the allow-listed types", async () => {
    const { data, error } = await adminClient().storage.getBucket(BUCKET);
    expect(error).toBeNull();
    expect(data!.public).toBe(false);
    expect(Number(data!.file_size_limit)).toBe(MAX_BYTES);
    expect([...(data!.allowed_mime_types ?? [])].sort()).toEqual([...ALLOWED_MIME].sort());
  });

  it("rejects a type outside the allow-list even for the service role (defence in depth)", async () => {
    const { path } = objectPath(officeId, "pdf");
    const { error } = await adminClient().storage.from(BUCKET).upload(path, Buffer.from("<html></html>"), { contentType: "text/html" });
    expect(error).not.toBeNull();
  });
});

describe("no direct access for app roles (AC-13)", () => {
  it.each([["anonymous", () => anon], ["signed-in staff", () => asStaff]] as const)("%s can't download, list, sign or upload", async (_label, get) => {
    const c = get();
    const store = c.storage.from(BUCKET);
    const dl = await store.download(existing.path);
    expect(dl.data).toBeNull();
    const { data: listed } = await store.list(`office/${officeId}/doc`);
    expect(listed ?? []).toEqual([]);
    const signed = await store.createSignedUrl(existing.path, 60);
    expect(signed.data).toBeNull();
    const up = await store.upload(objectPath(officeId, "pdf").path, TINY.pdf.bytes, { contentType: "application/pdf" });
    expect(up.error).not.toBeNull();
    const signedUpload = await store.createSignedUploadUrl(objectPath(officeId, "pdf").path);
    expect(signedUpload.data).toBeNull();
  });

  it("the public URL of an object does not serve it", async () => {
    const { data } = anon.storage.from(BUCKET).getPublicUrl(existing.path);
    const res = await fetch(data.publicUrl);
    expect(res.ok).toBe(false);
  });

  it("app roles can't read storage metadata tables through the API", async () => {
    const { data } = await asStaff.schema("storage").from("objects").select("name").limit(1);
    expect(data ?? []).toEqual([]);
  });
});
