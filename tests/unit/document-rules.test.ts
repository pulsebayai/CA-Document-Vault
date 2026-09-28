import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTENSIONS, CHANNELS, MAX_FILE_BYTES, MIME_BY_EXTENSION, RECEIVED_AS, canView, sanitiseFileName,
  validateDocumentMeta, validateFile,
} from "@/lib/validation/document";

// Spec 03 AC-1, AC-2, AC-4 — one set of rules for the Add document form, the server actions and the DB
// (private.mime_for_extension, document_version checks, bucket allow-list).

const MB = 1024 * 1024;

describe("validateFile (AC-2)", () => {
  it("accepts every allow-listed extension with its usual browser type and maps it to one stored type", () => {
    const cases: Array<[string, string, string]> = [
      ["gst.pdf", "application/pdf", "application/pdf"],
      ["scan.JPG", "image/jpeg", "image/jpeg"],
      ["scan.jpeg", "image/jpeg", "image/jpeg"],
      ["photo.png", "image/png", "image/png"],
      ["iphone.heic", "image/heic", "image/heic"],
      ["register.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["old.xls", "application/vnd.ms-excel", "application/vnd.ms-excel"],
      ["bank.csv", "text/csv", "text/csv"],
      ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["bundle.zip", "application/zip", "application/zip"],
    ];
    for (const [name, type, stored] of cases) {
      const r = validateFile({ name, size: 1000, type });
      expect(r.error, name).toBeNull();
      expect(r.data?.mime, name).toBe(stored);
    }
  });

  it("accepts the other types browsers declare for the same files (Windows zip, Excel-owned CSV, HEIF, none)", () => {
    expect(validateFile({ name: "a.zip", size: 10, type: "application/x-zip-compressed" }).data?.mime).toBe("application/zip");
    expect(validateFile({ name: "a.csv", size: 10, type: "application/vnd.ms-excel" }).data?.mime).toBe("text/csv");
    expect(validateFile({ name: "a.heic", size: 10, type: "image/heif" }).data?.mime).toBe("image/heic");
    expect(validateFile({ name: "a.heic", size: 10, type: "" }).data?.mime).toBe("image/heic");
  });

  it("rejects other extensions, and a declared type that contradicts the extension", () => {
    expect(validateFile({ name: "setup.exe", size: 10, type: "application/x-msdownload" }).error).toMatch(/isn't accepted/);
    expect(validateFile({ name: "notes.txt", size: 10, type: "text/plain" }).error).toMatch(/isn't accepted/);
    expect(validateFile({ name: "noextension", size: 10, type: "application/pdf" }).error).toMatch(/isn't accepted/);
    expect(validateFile({ name: "invoice.pdf", size: 10, type: "text/html" }).error).toMatch(/doesn't match/);
    expect(validateFile({ name: "invoice.pdf.exe", size: 10, type: "application/pdf" }).error).toMatch(/isn't accepted/);
  });

  it("rejects empty files and files over 25 MB; exactly 25 MB is fine", () => {
    expect(validateFile({ name: "a.pdf", size: 0, type: "application/pdf" }).error).toMatch(/empty/);
    expect(validateFile({ name: "a.pdf", size: 25 * MB + 1, type: "application/pdf" }).error).toMatch(/25 MB/);
    expect(validateFile({ name: "a.pdf", size: 25 * MB, type: "application/pdf" }).error).toBeNull();
    expect(MAX_FILE_BYTES).toBe(26214400);
  });

  it("the map matches the database's canonical list (same 10 extensions, 9 stored types)", () => {
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(["csv", "docx", "heic", "jpeg", "jpg", "pdf", "png", "xls", "xlsx", "zip"]);
    expect(new Set(Object.values(MIME_BY_EXTENSION)).size).toBe(9);
  });

  it("errors never repeat the file name (it may contain a client's name)", () => {
    const r = validateFile({ name: "Ravi Traders GST.exe", size: 10, type: "" });
    expect(r.error).not.toContain("Ravi");
  });
});

describe("sanitiseFileName (AC-2, DB check document_version_file_name)", () => {
  it("keeps ordinary names as they are", () => {
    expect(sanitiseFileName("GSTR-1 Aug 2026 (final).pdf")).toBe("GSTR-1 Aug 2026 (final).pdf");
    expect(sanitiseFileName("விலைப்பட்டியல்.pdf")).toBe("விலைப்பட்டியல்.pdf");
  });

  it("removes path separators, control characters and leading dots; tidies spaces", () => {
    expect(sanitiseFileName("../../etc/passwd.pdf")).toBe("etcpasswd.pdf");
    expect(sanitiseFileName("C:\\Users\\ravi\\bank.csv")).toBe("C:Usersravibank.csv");
    expect(sanitiseFileName("tab\there\u0000.pdf")).toBe("tab here.pdf");
    expect(sanitiseFileName("...hidden.pdf")).toBe("hidden.pdf");
    expect(sanitiseFileName("  lots   of   space .pdf ")).toBe("lots of space .pdf");
  });

  it("caps at 180 characters and keeps the extension", () => {
    const out = sanitiseFileName("x".repeat(300) + ".xlsx");
    expect(out.length).toBe(180);
    expect(out.endsWith(".xlsx")).toBe(true);
  });

  it("falls back to 'document.<ext>' when nothing is left", () => {
    expect(sanitiseFileName("....pdf", "pdf")).toBe("document.pdf");
    expect(sanitiseFileName("", "png")).toBe("document.png");
  });

  it("output always satisfies the DB rule", () => {
    const dbOk = (s: string) => s.length >= 1 && s.length <= 180 && !/[/\\\p{Cc}]/u.test(s) && !s.startsWith(".");
    for (const s of ["../a.pdf", "\u0007.pdf", ".", "a/b\\c.pdf", "x".repeat(500), " .pdf"]) {
      expect(dbOk(sanitiseFileName(s, "pdf")), JSON.stringify(s)).toBe(true);
    }
  });
});

describe("canView", () => {
  it("offers View for PDF and browser images only (HEIC is download-only)", () => {
    expect(canView("application/pdf")).toBe(true);
    expect(canView("image/jpeg")).toBe(true);
    expect(canView("image/png")).toBe(true);
    expect(canView("image/heic")).toBe(false);
    expect(canView("text/csv")).toBe(false);
  });
});

describe("validateDocumentMeta (AC-1, AC-4)", () => {
  const today = "2026-09-28";
  const base = { receivedAs: "soft_copy", channel: "whatsapp", receivedOn: today, remark: "", clientId: "", docTypeId: "" };
  const uuid = "3f1b1c7e-8a52-4a3e-9d7b-2c1e5f6a7b8c";

  it("lists received-as and channel options in the agreed order", () => {
    expect(RECEIVED_AS.map((r) => r.label)).toEqual(["Soft copy", "Hard copy", "Original"]);
    expect(CHANNELS.map((c) => c.label)).toEqual(["WhatsApp", "Email", "Hand delivery", "Courier", "Portal download", "Other"]);
  });

  it("Save to inbox needs only received-as, channel and date", () => {
    const r = validateDocumentMeta(base, { target: "inbox", hasFile: true, today });
    expect(r.errors).toEqual([]);
    expect(r.data).toMatchObject({ receivedAs: "soft_copy", channel: "whatsapp", receivedOn: today, remark: null, clientId: null, docTypeId: null });
  });

  it("Save to vault needs a client and a type", () => {
    const r = validateDocumentMeta(base, { target: "vault", hasFile: true, today });
    expect(r.errors.map((e) => e.field).sort()).toEqual(["clientId", "docTypeId"]);
    expect(validateDocumentMeta({ ...base, clientId: uuid, docTypeId: uuid }, { target: "vault", hasFile: true, today }).errors).toEqual([]);
  });

  it("a soft copy needs a file; a hard copy or original doesn't", () => {
    expect(validateDocumentMeta(base, { target: "inbox", hasFile: false, today }).errors).toEqual([{ field: "file", message: "Add the file — a soft copy needs one." }]);
    expect(validateDocumentMeta({ ...base, receivedAs: "hard_copy" }, { target: "inbox", hasFile: false, today }).errors).toEqual([]);
    expect(validateDocumentMeta({ ...base, receivedAs: "original" }, { target: "inbox", hasFile: false, today }).errors).toEqual([]);
  });

  it("received on is a real date, not in the future (India date)", () => {
    expect(validateDocumentMeta({ ...base, receivedOn: "2026-09-29" }, { target: "inbox", hasFile: true, today }).errors[0]?.field).toBe("receivedOn");
    expect(validateDocumentMeta({ ...base, receivedOn: "2026-02-30" }, { target: "inbox", hasFile: true, today }).errors[0]?.field).toBe("receivedOn");
    expect(validateDocumentMeta({ ...base, receivedOn: "" }, { target: "inbox", hasFile: true, today }).data?.receivedOn).toBe(today);
  });

  it("rejects unknown received-as / channel values and remarks over 500 characters", () => {
    const r = validateDocumentMeta({ ...base, receivedAs: "fax", channel: "pigeon", remark: "x".repeat(501) }, { target: "inbox", hasFile: true, today });
    expect(r.errors.map((e) => e.field).sort()).toEqual(["channel", "receivedAs", "remark"]);
  });

  it("ignores malformed IDs rather than passing them on", () => {
    const r = validateDocumentMeta({ ...base, clientId: "not-a-uuid" }, { target: "inbox", hasFile: true, today });
    expect(r.errors[0]?.field).toBe("clientId");
  });
});
