import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { ALLOWED_MIME, BUCKET, MAX_BYTES, TINY, createDocumentOffice, objectPath, uploadObject } from "../support/documents";
import {
  MAX_LINK_SECONDS, createFileLink, createUploadTicket, lookupVersion, objectPathFor, verifyStoredObject,
} from "@/lib/documents/storage-core";

// Feature 03 — files are never public (spec AC-13, AC-14; plan step 1). The signed-URL round trip
// (issue → upload → register → view/download → expiry) is tested at the end, against src/lib/documents/storage-core.ts.

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

// ── Plan step 4: the app's storage module (signed upload → register → signed view/download → expiry) ──
describe("signed upload and file links (AC-2, AC-11, AC-13)", () => {
  let limited: { id: string; email: string };
  let asLimited: SupabaseClient;
  let clientId: string;
  const file = { ext: "pdf" as const, mime: "application/pdf", size: TINY.pdf.bytes.length, fileName: "GSTR-1 Aug 2026.pdf" };
  let ticket: Awaited<ReturnType<typeof createUploadTicket>>;
  let versionId: string;

  beforeAll(async () => {
    limited = await createStaff(officeId, "storage-limited", "limited");
    asLimited = await signedInClient(limited.email);
    const { data, error } = await asStaff.from("client").insert({
      office_id: officeId, name: "Storage client", client_type: "individual", incharge_id: staff.id,
    }).select("id").single();
    if (error) throw error;
    clientId = data.id as string;
  });

  afterAll(async () => {
    if (limited) await retireStaff([limited.id]);
  });

  it("issues an upload ticket for an IDs-only path; the browser uploads with it (no service key)", async () => {
    ticket = await createUploadTicket(adminClient(), officeId, randomUUID(), file);
    expect(ticket.path).toMatch(new RegExp(`^office/${officeId}/doc/[0-9a-f-]{36}/[0-9a-f-]{36}\\.pdf$`));
    expect(ticket.path).toContain(ticket.documentId);
    expect(ticket.contentType).toBe("application/pdf");
    const up = await asStaff.storage.from(BUCKET).uploadToSignedUrl(ticket.path, ticket.token, TINY.pdf.bytes, { contentType: ticket.contentType });
    expect(up.error).toBeNull();
  });

  it("a ticket can't overwrite: uploading to the same path again fails", async () => {
    const again = await asStaff.storage.from(BUCKET).uploadToSignedUrl(ticket.path, ticket.token, TINY.pdf.bytes, { contentType: "application/pdf" });
    expect(again.error).not.toBeNull();
  });

  it("verifies the stored object's size and type before saving", async () => {
    expect(await verifyStoredObject(adminClient(), ticket.path, { size: file.size, mime: file.mime })).toBeNull();
    expect(await verifyStoredObject(adminClient(), ticket.path, { size: file.size + 1, mime: file.mime })).toMatch(/doesn't match/);
    expect(await verifyStoredObject(adminClient(), objectPathFor(officeId, randomUUID(), "pdf"), { size: 1, mime: file.mime })).toMatch(/didn't finish/);
  });

  it("registers the upload as a document and serves it back through a ≤ 60 s download link with its name", async () => {
    const { data, error } = await asStaff.rpc("create_document", { p: {
      received_as: "soft_copy", channel: "email", client_id: clientId,
      file: { storage_path: ticket.path, file_name: ticket.fileName },
    } });
    expect(error).toBeNull();
    const { data: v } = await adminClient().from("document_version").select("id").eq("document_id", (data as { id: string }).id).single();
    versionId = v!.id as string;

    const found = await lookupVersion(asStaff, versionId);
    expect(found).toMatchObject({ storagePath: ticket.path, fileName: "GSTR-1 Aug 2026.pdf", mimeType: "application/pdf", isCurrent: true });

    const url = await createFileLink(adminClient(), found!.storagePath, found!.fileName, "download");
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(Buffer.from(await res.arrayBuffer()).equals(TINY.pdf.bytes)).toBe(true);
    // RFC 6266: the name arrives percent-encoded in filename*=UTF-8''… — decode and require the exact stored name.
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment;/);
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe("GSTR-1 Aug 2026.pdf");

    const view = await fetch(await createFileLink(adminClient(), found!.storagePath, found!.fileName, "view"));
    expect(view.ok).toBe(true);
    expect(view.headers.get("content-disposition") ?? "").not.toMatch(/attachment/i);
  });

  it("links never live longer than 60 seconds, and stop working when they expire", async () => {
    const long = await createFileLink(adminClient(), ticket.path, "x.pdf", "download", 3600);
    const token = new URL(long).searchParams.get("token")!;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(MAX_LINK_SECONDS);

    const short = await createFileLink(adminClient(), ticket.path, "x.pdf", "download", 1);
    await new Promise((r) => setTimeout(r, 3000));
    expect((await fetch(short)).ok).toBe(false);
  });

  it("the lookup that gates every link runs under RLS: a Limited user who can't see the document gets nothing", async () => {
    expect(await lookupVersion(asLimited, versionId)).toBeNull();
    expect(await lookupVersion(asStaff, randomUUID())).toBeNull();
  });
});
