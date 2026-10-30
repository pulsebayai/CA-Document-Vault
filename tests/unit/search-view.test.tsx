import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, SEARCH_TEXT_KEY, type DocumentFilters } from "@/lib/validation/document-search";
import type { DocumentHit, FilterOptions } from "@/lib/search/queries";

// Spec 03b AC-5…AC-9, AC-11 — /documents view logic, with the server actions and router mocked.

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const searchDocuments = vi.fn();
const documentFacets = vi.fn();
const findClients = vi.fn();
vi.mock("@/lib/search/actions", () => ({
  searchDocuments: (i: unknown) => searchDocuments(i), documentFacets: (i: unknown) => documentFacets(i),
  findClients: (t: string, archived?: boolean) => findClients(t, archived), suggest: vi.fn(), openDocId: vi.fn(),
}));

const { SearchView, activeChips, rowText, withoutFilter } = await import("@/app/(app)/documents/(search)/search-view");

const G = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444";
const options: FilterOptions = {
  groups: [{ id: G, name: "GST" }], types: [{ id: T, name: "Sales register", groupId: G }],
  fys: [{ id: "fy1", code: "2026-27" }], periods: [{ id: "p1", fyId: "fy1", kind: "month", code: "2026-08", label: "Aug 2026" }],
  client: { id: C, name: "Acme Traders", code: "C0007" }, registrations: [],
};
const hit = (over: Partial<DocumentHit> = {}): DocumentHit => ({
  id: "d1", docCode: "DOC-FY26-27-00042", clientId: C, clientName: "Acme Traders", clientCode: "C0007", typeName: "Sales register",
  groupName: "GST", periodCode: "2026-08", periodLabel: "Aug 2026", receivedAs: "soft_copy", channel: "email",
  receivedOn: "2026-08-05", receivedByName: "Asha", status: "received", fileName: "sales-aug.pdf", archived: false, ...over,
});

beforeEach(() => {
  push.mockReset();
  window.sessionStorage.clear();
  searchDocuments.mockReset().mockResolvedValue({ ok: true, total: 1, rows: [hit()] });
  documentFacets.mockReset().mockResolvedValue({ ok: true, facets: [
    { facet: "channel", value: "email", label: "email", n: 1 }, { facet: "received_by", value: S, label: "Asha (inactive)", n: 1 },
  ] });
});
afterEach(cleanup);

const view = (f: Partial<DocumentFilters> = {}) => render(<SearchView filters={{ ...DEFAULT_FILTERS, ...f }} options={options} />);

describe("helpers", () => {
  it("rowText shows type · period, the client or Inbox, and how it came in", () => {
    expect(rowText(hit())).toEqual({ what: "Sales register · Aug 2026", who: "Acme Traders", how: "GST · Received 5 Aug 2026 by Asha · Email · sales-aug.pdf" });
    expect(rowText(hit({ clientName: null, typeName: null, groupName: null, periodLabel: null, periodCode: null, fileName: null, receivedAs: "hard_copy" })))
      .toEqual({ what: "No type", who: "Untagged", how: "Received 5 Aug 2026 by Asha · Email · Hard copy — no file" });
  });

  it("activeChips names each filter and its value, using facet labels for people", () => {
    const f: DocumentFilters = { ...DEFAULT_FILTERS, client: C, group: G, type: T, channel: "courier", by: S, from: "2026-08-01", archived: true };
    expect(activeChips(f, options, [{ facet: "received_by", value: S, label: "Asha (inactive)", n: 2 }]).map((c) => c.label)).toEqual([
      "Client: Acme Traders · C0007", "Group: GST", "Type: Sales register", "Channel: Courier", "Received by: Asha (inactive)",
      "From: 1 Aug 2026", "Including archived",
    ]);
  });

  it("withoutFilter clears dependants and goes back to page 1", () => {
    const f: DocumentFilters = { ...DEFAULT_FILTERS, group: G, type: T, fy: "fy1", period: "p1", client: C, registration: S, page: 3 };
    expect(withoutFilter(f, "group")).toMatchObject({ group: null, type: null, fy: "fy1", page: 1 });
    expect(withoutFilter(f, "fy")).toMatchObject({ fy: null, period: null, group: G });
    expect(withoutFilter(f, "client")).toMatchObject({ client: null, registration: null });
    expect(withoutFilter({ ...f, archived: true }, "archived").archived).toBe(false);
  });
});

describe("SearchView", () => {
  it("searches with the session-storage text and URL filters, and lists rows linking to the document (AC-5)", async () => {
    window.sessionStorage.setItem(SEARCH_TEXT_KEY, "sales  aug");
    view({ channel: "email", page: 2 });
    const list = await screen.findByRole("list", { name: "Documents" });
    expect(searchDocuments).toHaveBeenCalledWith({ text: "sales aug", filters: expect.objectContaining({ channel: "email", page: 2 }) });
    expect(documentFacets).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("searchbox", { name: "Search documents" })).toHaveValue("sales  aug");
    expect(screen.getByText("1 document")).toBeInTheDocument();
    const row = within(list).getByRole("listitem");
    expect(row).toHaveTextContent("DOC-FY26-27-00042 · Sales register · Aug 2026 · Acme Traders");
    expect(within(row).getByRole("link")).toHaveAttribute("href", "/documents/d1");
  });

  it("facet counts label the filter options, and a value with no results is not offered (AC-7)", async () => {
    view();
    await screen.findByRole("list", { name: "Documents" });
    const channel = screen.getByRole("combobox", { name: "Channel" });
    expect(within(channel).getAllByRole("option").map((o) => o.textContent)).toEqual(["Channel: all", "Channel: Email (1)"]);
    expect(within(screen.getByRole("combobox", { name: "Received by" })).getByRole("option", { name: "Received by: Asha (inactive) (1)" })).toBeInTheDocument();
  });

  it("choosing a filter writes the URL (filters only, page 1) and never the text (AC-6, AC-11)", async () => {
    window.sessionStorage.setItem(SEARCH_TEXT_KEY, "secret words");
    const user = userEvent.setup();
    view({ page: 4 });
    await screen.findByRole("list", { name: "Documents" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Channel" }), "email");
    expect(push).toHaveBeenCalledWith("/documents?channel=email", { scroll: false });
    await user.click(screen.getByRole("checkbox", { name: "Include archived" }));
    for (const [href] of push.mock.calls) expect(href).not.toMatch(/secret|words/);
  });

  it("each active filter is a named chip that removes itself; Clear all keeps the sort (AC-6)", async () => {
    const user = userEvent.setup();
    view({ channel: "email", group: G, type: T, sort: "docid" });
    await screen.findByRole("list", { name: "Documents" });
    await user.click(screen.getByRole("button", { name: "Remove filter Group: GST" }));
    expect(push).toHaveBeenLastCalledWith("/documents?channel=email&sort=docid", { scroll: false });
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(push).toHaveBeenLastCalledWith("/documents?sort=docid", { scroll: false });
  });

  it("typing updates session storage (not the URL) and searches again", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByRole("list", { name: "Documents" });
    await user.type(screen.getByRole("searchbox", { name: "Search documents" }), "gst");
    expect(window.sessionStorage.getItem(SEARCH_TEXT_KEY)).toBe("gst");
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
    expect(searchDocuments).toHaveBeenLastCalledWith({ text: "gst", filters: expect.any(Object) });
    expect(push).not.toHaveBeenCalled();
  });

  it("no match: says so and offers to clear filters and text (AC-9)", async () => {
    searchDocuments.mockResolvedValue({ ok: true, total: 0, rows: [] });
    window.sessionStorage.setItem(SEARCH_TEXT_KEY, "nothing");
    const user = userEvent.setup();
    view({ channel: "email" });
    expect(await screen.findByText("No documents match.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search text" }));
    expect(window.sessionStorage.getItem(SEARCH_TEXT_KEY)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(push).toHaveBeenLastCalledWith("/documents", { scroll: false });
  });

  it("paging: Previous/Next with page N of M (AC-5)", async () => {
    searchDocuments.mockResolvedValue({ ok: true, total: 120, rows: [hit()] });
    const user = userEvent.setup();
    view({ page: 2 });
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(push).toHaveBeenLastCalledWith("/documents?page=3", { scroll: false });
  });

  it("an error shows the message and Try again runs the search again (AC-9)", async () => {
    searchDocuments.mockResolvedValueOnce({ ok: false, error: "Could not load documents. Please try again. (Ref 1a2b3c4d)" });
    const user = userEvent.setup();
    view();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load documents");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Documents" })).toBeInTheDocument();
  });

  it("the client filter finds clients by typing and picks one", async () => {
    findClients.mockResolvedValue({ ok: true, clients: [{ id: C, name: "Acme Traders", code: "C0007" }] });
    const user = userEvent.setup();
    render(<SearchView filters={DEFAULT_FILTERS} options={{ ...options, client: null }} />);
    await user.type(screen.getByRole("searchbox", { name: "Client" }), "acme");
    await user.click(await screen.findByRole("button", { name: "Acme Traders · C0007" }, { timeout: 2000 }));
    expect(push).toHaveBeenLastCalledWith(`/documents?client=${C}`, { scroll: false });
  });

  it("with Include archived on, the client filter also finds archived clients, marked as such (review fix 2026-10-01)", async () => {
    findClients.mockResolvedValue({ ok: true, clients: [{ id: C, name: "Acme Traders", code: "C0007", archived: true }] });
    const user = userEvent.setup();
    render(<SearchView filters={{ ...DEFAULT_FILTERS, archived: true }} options={{ ...options, client: null }} />);
    await user.type(screen.getByRole("searchbox", { name: "Client" }), "acme");
    await user.click(await screen.findByRole("button", { name: "Acme Traders · C0007 · Archived" }, { timeout: 2000 }));
    expect(findClients).toHaveBeenLastCalledWith("acme", true);
    expect(push).toHaveBeenLastCalledWith(`/documents?client=${C}&archived=1`, { scroll: false });
  });
});
