import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, type DocumentFilters } from "@/lib/validation/document-search";
import type { DocumentHit, FilterOptions } from "@/lib/search/queries";

// Feature 15 (spec AC-1…AC-7, U3–U5) — Client › All documents: 03b's /documents view scoped to one client, with the
// Last activity line (one call per page) and the expandable row (5 events + See all). Server actions and router mocked.

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/custody/actions", () => ({ markCustody: vi.fn(), undoCustody: vi.fn() }));
vi.mock("@/lib/documents/actions", () => ({ getFileLink: vi.fn() }));
const searchDocuments = vi.fn();
const documentFacets = vi.fn();
const findClients = vi.fn();
vi.mock("@/lib/search/actions", () => ({
  searchDocuments: (i: unknown) => searchDocuments(i), documentFacets: (i: unknown) => documentFacets(i),
  findClients: (t: string, a?: boolean) => findClients(t, a), suggest: vi.fn(), openDocId: vi.fn(),
}));
const lastActivity = vi.fn();
const documentEvents = vi.fn();
vi.mock("@/lib/activity-feed/actions", () => ({
  lastActivity: (ids: unknown) => lastActivity(ids), documentEvents: (id: unknown) => documentEvents(id), loadEarlier: vi.fn(),
}));

const { AllDocumentsView } = await import("@/app/(app)/clients/[id]/all-documents-view");

const C = "33333333-3333-4333-8333-333333333333";
const G = "11111111-1111-4111-8111-111111111111";
const FY = "55555555-5555-4555-8555-555555555555";
const FY_OLD = "66666666-6666-4666-8666-666666666666";
const options: FilterOptions = {
  groups: [{ id: G, name: "GST" }], types: [], periods: [],
  fys: [{ id: FY, code: "2026-27" }, { id: FY_OLD, code: "2025-26" }],
  client: { id: C, name: "Acme Traders", code: "C0007" }, registrations: [],
};
const hit = (over: Partial<DocumentHit> = {}): DocumentHit => ({
  id: "d1", docCode: "DOC-FY26-27-00042", clientId: C, clientName: "Acme Traders", clientCode: "C0007", typeName: "Sales register",
  groupName: "GST", periodCode: "2026-08", periodLabel: "Aug 2026", receivedAs: "soft_copy", channel: "email",
  receivedOn: "2026-08-05", receivedByName: "Asha", status: "received", fileName: "sales-aug.pdf", archived: false, ...over,
});
const feedRow = (id: number, action: string) => ({
  id, at: new Date(Date.now() - id * 60_000).toISOString(), action, entity_type: "document", entity_id: "d1", data: {},
  actor_id: "s1", actor_name: "Priya Raman", client_id: C, client_name: "Acme Traders", document_id: "d1",
  doc_code: "DOC-FY26-27-00042", doc_type_name: "Sales register", doc_group_name: "GST",
});

beforeEach(() => {
  push.mockReset();
  window.sessionStorage.clear();
  searchDocuments.mockReset().mockResolvedValue({ ok: true, total: 2, rows: [hit(), hit({ id: "d2", docCode: "DOC-FY26-27-00043" })] });
  documentFacets.mockReset().mockResolvedValue({ ok: true, facets: [] });
  lastActivity.mockReset().mockResolvedValue({ ok: true, rows: [{
    document_id: "d1", id: 9, at: new Date(Date.now() - 5 * 60_000).toISOString(), action: "document.ready", entity_type: "document",
    data: {}, actor_id: "s1", actor_name: "Priya Raman", doc_type_name: "Sales register", doc_group_name: "GST",
  }] });
  documentEvents.mockReset().mockResolvedValue({ ok: true, page: { rows: [1, 2, 3, 4, 5].map((i) => feedRow(i, "document.updated")), next: null } });
});
afterEach(cleanup);

const view = (f: Partial<DocumentFilters> = {}) =>
  render(<AllDocumentsView clientId={C} filters={{ ...DEFAULT_FILTERS, client: C, fy: FY, ...f }} options={options} currentFyId={FY} />);

describe("All documents tab (AC-2)", () => {
  it("searches this client in the current FY, with no client picker and no client chip", async () => {
    view();
    await screen.findByText(/DOC-FY26-27-00042/);
    expect(searchDocuments).toHaveBeenCalledWith(expect.objectContaining({ filters: expect.objectContaining({ client: C, fy: FY }) }));
    expect(screen.queryByRole("searchbox", { name: "Client" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull(); // client and the default FY are no chips
  });

  it("a filter stays on the client page (tab=all), never with a client parameter", async () => {
    documentFacets.mockResolvedValue({ ok: true, facets: [{ facet: "group", value: G, label: "GST", n: 2 }] });
    view();
    await screen.findByText(/DOC-FY26-27-00042/);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Group" }), G);
    expect(push).toHaveBeenCalledWith(`/clients/${C}?tab=all&group=${G}&fy=${FY}`, { scroll: false });
  });

  it("the FY select offers All years, kept as fy=all", async () => {
    view();
    await screen.findByText(/DOC-FY26-27-00042/);
    const fy = screen.getByRole("combobox", { name: "FY" });
    expect(within(fy).getByRole("option", { name: "FY: All years" })).toBeTruthy();
    await userEvent.selectOptions(fy, "");
    expect(push).toHaveBeenCalledWith(`/clients/${C}?tab=all&fy=all`, { scroll: false });
  });
});

describe("empty states (AC-4)", () => {
  it("nothing in the current FY: says so and links to All years", async () => {
    searchDocuments.mockResolvedValue({ ok: true, total: 0, rows: [] });
    view();
    expect(await screen.findByText("No documents for 2026-27 yet.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show all years" }));
    expect(push).toHaveBeenCalledWith(`/clients/${C}?tab=all&fy=all`, { scroll: false });
  });

  it("filtered and empty: Clear filters goes back to this client's current FY", async () => {
    searchDocuments.mockResolvedValue({ ok: true, total: 0, rows: [] });
    view({ group: G });
    expect(await screen.findByText("No documents match.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(push).toHaveBeenCalledWith(`/clients/${C}?tab=all&fy=${FY}`, { scroll: false });
  });
});

describe("Last activity (AC-5, AC-6)", () => {
  it("one call for the page; who · sentence · when; a document without a visible event shows —", async () => {
    view();
    const rows = await screen.findAllByText(/^Last activity/);
    expect(lastActivity).toHaveBeenCalledTimes(1);
    expect(lastActivity).toHaveBeenCalledWith(["d1", "d2"]);
    expect(await screen.findByText("Priya · marked Sales register ready to dispatch · 5 min ago")).toBeTruthy();
    expect(rows).toHaveLength(2);
    expect(within(rows[1].closest("p")!).getByText("—")).toBeTruthy();
  });

  it("a failed call leaves the column at — with no error banner", async () => {
    lastActivity.mockResolvedValue({ ok: false, error: "Last activity could not be loaded." });
    view();
    await screen.findByText(/DOC-FY26-27-00042/);
    await screen.findAllByText("—");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("expanded row (AC-7)", () => {
  it("toggle with aria-expanded loads 5 events once, and See all opens the document's Activity", async () => {
    view();
    const toggle = await screen.findByRole("button", { name: "Show activity for DOC-FY26-27-00042" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = await screen.findByRole("list", { name: "Activity of DOC-FY26-27-00042" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(within(list).getAllByText(/Priya edited Sales register/)).toHaveLength(5);
    expect(documentEvents).toHaveBeenCalledWith("d1");
    expect(screen.getByRole("link", { name: "See all activity for DOC-FY26-27-00042" }).getAttribute("href")).toBe("/activity?document=d1");
    await userEvent.click(toggle); // collapse
    expect(screen.queryByRole("list", { name: "Activity of DOC-FY26-27-00042" })).toBeNull();
    await userEvent.click(toggle); // re-expand re-uses the loaded events
    await screen.findByRole("list", { name: "Activity of DOC-FY26-27-00042" });
    expect(documentEvents).toHaveBeenCalledTimes(1);
  });

  it("no events: says so; an error shows inline with Retry", async () => {
    documentEvents.mockResolvedValueOnce({ ok: false, error: "Activity could not be loaded. Please try again." })
      .mockResolvedValueOnce({ ok: true, page: { rows: [], next: null } });
    view();
    await userEvent.click(await screen.findByRole("button", { name: "Show activity for DOC-FY26-27-00042" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Activity could not be loaded");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No activity yet.")).toBeTruthy();
    expect(documentEvents).toHaveBeenCalledTimes(2);
  });
});
