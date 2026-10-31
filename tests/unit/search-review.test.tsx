import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, type DocumentFilters } from "@/lib/validation/document-search";
import type { DocumentHit, FilterOptions } from "@/lib/search/queries";

// Feature 07 step 7 (AC-14) — /documents: the Status values, the Return filter (URL, chips) and the shown state on
// result rows. Server actions and the router are mocked; the SQL side is tests/rls/review-dispatch.test.ts.

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/documents/actions", () => ({ getFileLink: vi.fn() })); // 12 (AC-18): rows show 03's file buttons (approved 2026-10-30)
const searchDocuments = vi.fn();
const documentFacets = vi.fn();
vi.mock("@/lib/search/actions", () => ({
  searchDocuments: (i: unknown) => searchDocuments(i), documentFacets: (i: unknown) => documentFacets(i),
  findClients: vi.fn(), suggest: vi.fn(), openDocId: vi.fn(),
}));
const { SearchView, activeChips, rowState, withoutFilter } = await import("@/app/(app)/documents/(search)/search-view");

const C = "33333333-3333-4333-8333-333333333333";
const options: FilterOptions = { groups: [], types: [], fys: [], periods: [], client: null, registrations: [] };
const hit = (over: Partial<DocumentHit> = {}): DocumentHit => ({
  id: "d1", docCode: "DOC-FY26-27-00042", clientId: C, clientName: "Acme Traders", clientCode: "C0007", typeName: "Form 16",
  groupName: "Income Tax", periodCode: "2025-26", periodLabel: "FY 2025-26", receivedAs: "original", channel: "courier",
  receivedOn: "2026-08-05", receivedByName: "Asha", status: "reviewed", fileName: null, archived: false,
  docTypeId: "t1", reviewedAt: "2026-08-06T06:00:00Z", reviewedByName: "Ravi", correctionReason: null, dispatchedOn: null, dispatchMethod: null,
  custody: "ready", inOfficeAt: "2026-08-07T06:00:00Z", // 13 (plan test list, approved 2026-10-31): Ready is a stored step
  ...over,
});

beforeEach(() => {
  push.mockReset();
  window.sessionStorage.clear();
  searchDocuments.mockReset().mockResolvedValue({ ok: true, total: 2, rows: [hit(), hit({ id: "d2", docCode: "DOC-FY26-27-00043", dispatchedOn: "2026-08-20", dispatchMethod: "courier" })] });
  documentFacets.mockReset().mockResolvedValue({ ok: true, facets: [
    { facet: "status", value: "received", label: "received", n: 3 },
    { facet: "status", value: "reviewed", label: "reviewed", n: 2 },
    { facet: "return", value: "to_place", label: "to_place", n: 2 }, // 13: the Custody filter's four values
    { facet: "return", value: "in_office", label: "in_office", n: 4 },
    { facet: "return", value: "ready", label: "ready", n: 1 },
    { facet: "return", value: "dispatched", label: "dispatched", n: 1 },
  ] });
});
afterEach(cleanup);

describe("/documents Status and Return (AC-14)", () => {
  // 13 (plan test list, approved 2026-10-31): "Return" is named "Custody" and lists four values.
  it("offers To review · Reviewed with counts, and To place · In office · Ready to dispatch · Dispatched", async () => {
    render(<SearchView filters={DEFAULT_FILTERS} options={options} />);
    await screen.findByRole("list", { name: "Documents" });
    expect(screen.getByRole("option", { name: "Status: To review (3)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custody: To place in office (2)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custody: Document in office (4)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custody: Ready to dispatch (1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custody: Dispatched (1)" })).toBeInTheDocument();
  });

  it("choosing Custody writes an enum to the URL; choosing To review also shows filed documents only", async () => {
    const user = userEvent.setup();
    render(<SearchView filters={DEFAULT_FILTERS} options={options} />);
    await screen.findByRole("list", { name: "Documents" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Custody" }), "ready");
    expect(push).toHaveBeenLastCalledWith("/documents?return=ready", { scroll: false });
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "received");
    expect(push).toHaveBeenLastCalledWith("/documents?status=received&state=classified", { scroll: false });
  });

  it("rows show their shown state", async () => {
    render(<SearchView filters={DEFAULT_FILTERS} options={options} />);
    expect(await screen.findByText("Ready to dispatch")).toBeInTheDocument();
    expect(screen.getByText("Dispatched 20 Aug · Courier")).toBeInTheDocument();
  });

  it("the Custody chip and its removal", () => {
    const f: DocumentFilters = { ...DEFAULT_FILTERS, return: "dispatched" };
    expect(activeChips(f, options, []).map((c) => c.label)).toEqual(["Custody: Dispatched"]); // 13: "Return" renamed (approved 2026-10-31)
    const next = withoutFilter(f, "return");
    expect("return" in next).toBe(false);
    expect(activeChips(DEFAULT_FILTERS, options, [])).toEqual([]);
  });

  it("rowState follows the spec order (Inbox rows have no type)", () => {
    expect(rowState(hit({ typeName: null, docTypeId: null }), "2026-10-01").kind).toBe("inbox");
    expect(rowState(hit({ status: "needs_correction", correctionReason: "Blurred", receivedAs: "hard_copy" }), "2026-10-01").text).toBe("Needs correction · Blurred");
  });
});
