import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_TEXT_KEY } from "@/lib/validation/document-search";

// Spec 03b AC-1…AC-4, AC-11 — the header combobox. Server actions and the router are mocked;
// the database side is proven in tests/rls/document-search.test.ts and the full flow in tests/e2e/search.spec.ts.

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const suggest = vi.fn();
const openDocId = vi.fn();
vi.mock("@/lib/search/actions", () => ({ suggest: (t: string) => suggest(t), openDocId: (t: string) => openDocId(t) }));

const { HeaderSearch, isEditableTarget } = await import("@/components/header-search");

const C1 = "11111111-1111-4111-8111-111111111111";
const D1 = "22222222-2222-4222-8222-222222222222";
const hits = {
  ok: true as const,
  clients: [{ id: C1, name: "Acme Traders", code: "C0007" }],
  documents: [{
    id: D1, docCode: "DOC-FY26-27-00042", clientId: C1, clientName: "Acme Traders", clientCode: "C0007", typeName: "Form 16",
    groupName: "Income Tax", periodCode: "2026-27", periodLabel: "FY 2026-27", receivedAs: "hard_copy", channel: "email",
    receivedOn: "2026-08-01", receivedByName: "Asha", status: "received", fileName: "form16.pdf", archived: false,
  }],
  exact: null,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  push.mockReset();
  suggest.mockReset().mockResolvedValue(hits);
  openDocId.mockReset();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const setup = () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<><input aria-label="Other field" /><textarea aria-label="Notes" /><div contentEditable aria-label="Editor" suppressContentEditableWarning>x</div><HeaderSearch /></>);
  return { user, box: screen.getByRole("combobox", { name: "Search clients and documents" }) };
};
const settle = async () => act(async () => { await vi.advanceTimersByTimeAsync(300); });

describe("the \"/\" shortcut (AC-1)", () => {
  it("focuses the search box from anywhere that isn't a field", async () => {
    const { user, box } = setup();
    await user.keyboard("/");
    expect(box).toHaveFocus();
    expect(box).toHaveValue(""); // the "/" itself is not typed
    expect(box).toHaveAttribute("aria-keyshortcuts", "/");
  });

  it("does nothing while the user is typing in an input, textarea or editable element", async () => {
    const { user, box } = setup();
    for (const name of ["Other field", "Notes"]) {
      await user.click(screen.getByRole("textbox", { name }));
      await user.keyboard("/");
      expect(box).not.toHaveFocus();
    }
    expect(screen.getByRole("textbox", { name: "Other field" })).toHaveValue("/");
    expect(isEditableTarget(screen.getByLabelText("Editor"))).toBe(true);
    expect(isEditableTarget(document.body)).toBe(false);
  });

  it("ignores Ctrl/Cmd + /", async () => {
    const { user, box } = setup();
    await user.keyboard("{Control>}/{/Control}");
    expect(box).not.toHaveFocus();
  });
});

describe("suggestions (AC-2)", () => {
  it("waits for 2 characters and a 250 ms pause, then asks once", async () => {
    const { user, box } = setup();
    await user.type(box, "a");
    await settle();
    expect(suggest).not.toHaveBeenCalled();
    expect(box).toHaveAttribute("aria-expanded", "false");
    await user.type(box, "cm");
    await settle();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledWith("acm");
  });

  it("shows Clients and Documents groups and a final \"See all results\" option", async () => {
    const { user, box } = setup();
    await user.type(box, "acme");
    await settle();
    expect(box).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox", { name: "Search suggestions" });
    expect(within(within(list).getByRole("group", { name: "Clients" })).getByRole("option")).toHaveTextContent("Acme Traders · C0007");
    expect(within(within(list).getByRole("group", { name: "Documents" })).getByRole("option"))
      .toHaveTextContent("DOC-FY26-27-00042 · Form 16 · FY 2026-27 · Acme Traders · form16.pdf");
    const options = within(list).getAllByRole("option");
    expect(options.at(-1)).toHaveTextContent("See all results for “acme”");
    expect(screen.getByTestId("search-status")).toHaveTextContent("1 clients and 1 documents");
    expect(screen.queryByRole("status")).toBeNull(); // pages keep their single status region (review: client-edit e2e)
  });

  it("says when nothing matches, and shows Inbox for an unclassified document", async () => {
    suggest.mockResolvedValueOnce({ ...hits, clients: [], documents: [] });
    const { user, box } = setup();
    await user.type(box, "zzz");
    await settle();
    expect(screen.getByTestId("search-status")).toHaveTextContent("No matching clients or documents");
    suggest.mockResolvedValueOnce({ ...hits, clients: [], documents: [{ ...hits.documents[0], clientName: null, typeName: null, periodLabel: null, periodCode: null }] });
    await user.type(box, "z");
    await settle();
    expect(screen.getByRole("option", { name: /DOC-FY26-27-00042/ })).toHaveTextContent("DOC-FY26-27-00042 · No type · Untagged · form16.pdf");
  });

  it("ignores an answer that arrives after a newer one", async () => {
    let resolveOld!: (v: unknown) => void;
    suggest.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    suggest.mockImplementationOnce(async () => ({ ...hits, clients: [{ id: C1, name: "Newer Co", code: "C0009" }], documents: [] }));
    const { user, box } = setup();
    await user.type(box, "ne");
    await settle(); // first request in flight
    await user.type(box, "w");
    await settle(); // second request answered
    await act(async () => { resolveOld({ ...hits, clients: [{ id: C1, name: "Stale Ltd", code: "C0001" }] }); });
    expect(screen.getByRole("option", { name: /Newer Co/ })).toBeInTheDocument();
    expect(screen.queryByText(/Stale Ltd/)).toBeNull();
  });
});

describe("keyboard (AC-1)", () => {
  it("arrow keys move through the options (aria-activedescendant) and wrap; Enter opens the highlighted one", async () => {
    const { user, box } = setup();
    await user.type(box, "acme");
    await settle();
    const options = screen.getAllByRole("option");
    await user.keyboard("{ArrowDown}");
    expect(box).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(box).toHaveAttribute("aria-activedescendant", options[options.length - 2].id);
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowDown}"); // 1 → 0 → wraps to the end → wraps to the start
    expect(box).toHaveAttribute("aria-activedescendant", options[0].id);
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith(`/clients/${C1}`);
    expect(box).toHaveFocus();
  });

  it("Enter on a document option opens the document; clicking an option works too", async () => {
    const { user, box } = setup();
    await user.type(box, "acme");
    await settle();
    await user.click(screen.getByRole("option", { name: /DOC-FY26-27-00042/ }));
    expect(push).toHaveBeenCalledWith(`/documents/${D1}`);
  });

  it("Esc closes the list and keeps the text", async () => {
    const { user, box } = setup();
    await user.type(box, "acme");
    await settle();
    await user.keyboard("{Escape}");
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(box).not.toHaveAttribute("aria-activedescendant");
    expect(box).toHaveValue("acme");
  });
});

describe("DOC-ID jump (AC-3)", () => {
  it("Enter on a complete DOC-ID opens that document", async () => {
    openDocId.mockResolvedValue({ ok: true, id: D1 });
    const { user, box } = setup();
    await user.type(box, "  doc-fy26-27-00042 ");
    await user.keyboard("{Enter}");
    await settle();
    expect(openDocId).toHaveBeenCalledWith("DOC-FY26-27-00042");
    expect(push).toHaveBeenCalledWith(`/documents/${D1}`);
  });

  it("says so when the user can't open it", async () => {
    openDocId.mockResolvedValue({ ok: false, error: "No document DOC-FY26-27-00123 that you can open" });
    const { user, box } = setup();
    await user.type(box, "DOC-FY26-27-00123");
    await user.keyboard("{Enter}");
    await settle();
    expect(await screen.findByRole("alert")).toHaveTextContent("No document DOC-FY26-27-00123 that you can open");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("See all (AC-4, AC-11)", () => {
  it("Enter with nothing highlighted hands the text over in session storage and opens /documents with no text in the URL", async () => {
    const { user, box } = setup();
    await user.type(box, "  bank   statement ");
    await user.keyboard("{Enter}");
    expect(window.sessionStorage.getItem(SEARCH_TEXT_KEY)).toBe("bank statement");
    expect(push).toHaveBeenCalledWith("/documents");
    expect(openDocId).not.toHaveBeenCalled();
  });

  it("the \"See all results\" option does the same", async () => {
    const { user, box } = setup();
    await user.type(box, "acme");
    await settle();
    await user.click(screen.getByRole("option", { name: /See all results/ }));
    expect(window.sessionStorage.getItem(SEARCH_TEXT_KEY)).toBe("acme");
    expect(push).toHaveBeenCalledWith("/documents");
  });

  it("no navigation ever carries the typed text", async () => {
    openDocId.mockResolvedValue({ ok: true, id: D1 });
    const { user, box } = setup();
    await user.type(box, "acme");
    await settle();
    await user.keyboard("{ArrowDown}{Enter}");
    await user.clear(box);
    await user.type(box, "acme{Enter}");
    for (const [href] of push.mock.calls) expect(href).not.toMatch(/acme/i);
  });
});

describe("phones (AC-1)", () => {
  it("a Search button opens the field, and Close closes it", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Search" }));
    const box = screen.getByRole("combobox");
    expect(box).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.queryByRole("button", { name: "Close search" })).toBeNull();
  });
});
