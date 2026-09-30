import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spec 03b AC-2…AC-4, AC-11: the server actions' contract with the database, with Supabase mocked.
// (Visibility itself is proven against the real database in tests/rls/document-search.test.ts.)

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/staff", () => ({ requireStaff: vi.fn(async () => ({ id: "me", role: "staff" })) }));

const rpc = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc, from }) }));

const { suggest, searchDocuments, documentFacets, openDocId } = await import("@/lib/search/actions");

const A = "11111111-1111-4111-8111-111111111111";
const row = {
  id: "d1", doc_code: "DOC-FY26-27-00001", client_id: A, client_name: "Acme", client_code: "C0001", type_name: "Form 16",
  group_name: "Income Tax", period_code: "2026-27", period_label: "FY 2026-27", received_as: "hard_copy", channel: "email",
  received_on: "2026-08-01", received_by_name: "Asha", status: "received", file_name: null, archived_at: null,
};

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  rpc.mockReset();
  maybeSingle.mockReset();
  eq.mockClear();
  from.mockClear();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

const rpcCall = (name: string) => rpc.mock.calls.find((c) => c[0] === name);

describe("suggest (AC-2)", () => {
  it("does nothing below 2 characters", async () => {
    expect(await suggest(" a ")).toEqual({ ok: true, clients: [], documents: [], exact: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks for 5 clients and 5 documents with the normalised text", async () => {
    rpc.mockImplementation(async (name: string) =>
      name === "search_clients" ? { data: [{ id: A, name: "Acme", code: "C0001", pan: "x" }], error: null } : { data: { total: 1, rows: [row] }, error: null });
    const r = await suggest("  acme   form ");
    expect(rpcCall("search_clients")![1]).toEqual({ p_query: "acme form", p_limit: 5, p_offset: 0 });
    expect(rpcCall("search_documents")![1]).toEqual({ p: { text: "acme form", filters: {}, include_archived: false, sort: "received", page: 1, page_size: 5 } });
    expect(r).toEqual({
      ok: true, exact: null,
      clients: [{ id: A, name: "Acme", code: "C0001" }], // no PAN or other fields reach the browser
      documents: [expect.objectContaining({ id: "d1", docCode: "DOC-FY26-27-00001", clientName: "Acme", archived: false })],
    });
    expect(from).not.toHaveBeenCalled(); // no DOC-ID lookup for ordinary text
  });

  it("also looks up an exact DOC-ID", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    maybeSingle.mockResolvedValue({ data: { id: "d9", doc_code: "DOC-FY26-27-00009" }, error: null });
    const r = await suggest("doc-fy26-27-00009");
    expect(eq).toHaveBeenCalledWith("doc_code", "DOC-FY26-27-00009");
    expect(r).toMatchObject({ ok: true, exact: { id: "d9", docCode: "DOC-FY26-27-00009" } });
  });
});

describe("searchDocuments / documentFacets (AC-5…AC-8)", () => {
  it("re-validates filters from the browser and maps them to the function's keys", async () => {
    rpc.mockResolvedValue({ data: { total: 1, rows: [row] }, error: null });
    const r = await searchDocuments({ text: " hdfc ", filters: { client: A, channel: "fax", from: "2026-13-01", page: 2, sort: "docid", evil: "x" } });
    expect(rpcCall("search_documents")![1]).toEqual({
      p: { text: "hdfc", filters: { client_id: A }, include_archived: false, sort: "docid", page: 2 },
    });
    expect(r).toMatchObject({ ok: true, total: 1 });
  });

  it("tolerates missing input", async () => {
    rpc.mockResolvedValue({ data: { total: 0, rows: [] }, error: null });
    expect(await searchDocuments({})).toEqual({ ok: true, total: 0, rows: [] });
    expect(rpcCall("search_documents")![1]).toEqual({ p: { filters: {}, include_archived: false, sort: "received", page: 1 } });
  });

  it("facets use the same input and fill in a missing label", async () => {
    rpc.mockResolvedValue({ data: [{ facet: "channel", value: "email", label: null, n: 3 }], error: null });
    const r = await documentFacets({ text: "gst", filters: { archived: true } });
    expect(rpcCall("search_document_facets")![1]).toEqual({ p: { text: "gst", filters: {}, include_archived: true, sort: "received", page: 1 } });
    expect(r).toEqual({ ok: true, facets: [{ facet: "channel", value: "email", label: "email", n: 3 }] });
  });
});

describe("errors (AC-11: code + request ID only)", () => {
  it("logs the error code and a request ID, never the search text or filters, and tells the user a reference", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const r = await searchDocuments({ text: "Sharma Traders PAN ZZZPZ1234Z", filters: { client: A } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^Could not load documents\. Please try again\. \(Ref [0-9a-f]{8}\)$/);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [event, detail] = errorLog.mock.calls[0];
    expect(event).toBe("search.documents_failed");
    expect(Object.keys(detail as object).sort()).toEqual(["code", "requestId"]);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toMatch(/Sharma|ZZZPZ|11111111/);
  });
});

describe("openDocId (AC-3)", () => {
  it("rejects text that isn't a complete DOC-ID without a lookup", async () => {
    expect(await openDocId("DOC-FY26-27-12")).toEqual({ ok: false, error: "That isn't a complete DOC-ID." });
    expect(from).not.toHaveBeenCalled();
  });

  it("returns the id of a document the user can open", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "d7", doc_code: "DOC-FY26-27-00007" }, error: null });
    expect(await openDocId("  doc-fy26-27-00007 ")).toEqual({ ok: true, id: "d7" });
  });

  it("says so when there is no such document the user can open (RLS returns no row)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await openDocId("doc-fy26-27-00123")).toEqual({ ok: false, error: "No document DOC-FY26-27-00123 that you can open" });
  });
});
