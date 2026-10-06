import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Feature 08 AC-1 (selection, per page), AC-2 (zip cap in the bar), AC-3 (confirm → chunks → result).
// The rules themselves are enforced by review_documents and zipManifest (tests/rls/bulk.test.ts).

const markReviewedBulk = vi.fn();
vi.mock("@/lib/bulk/actions", () => ({ markReviewedBulk, getZipManifest: vi.fn(), getFileLinks: vi.fn() }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeAll(() => {
  // jsdom has no showModal/close on <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const { RowCheckbox, SelectAll, SelectionBar, useSelection, ZIP_CAP_TEXT } = await import("@/components/selection-bar");
const { confirmText, resultText } = await import("@/components/bulk-review-dialog");
type Target = import("@/components/bulk-review-dialog").ReviewTarget;

const doc = (n: number, skip: Target["skip"] = null): Target => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, docCode: `DOC-FY26-27-${String(n).padStart(5, "0")}`, skip,
});

function Harness({ rows, pageKey }: { rows: Target[]; pageKey: string }) {
  const sel = useSelection(pageKey);
  const ids = rows.map((r) => r.id);
  return (
    <div>
      <SelectAll pageIds={ids} selected={sel.ids} onChange={(on) => sel.setAll(ids, on)} />
      <ul>{rows.map((r) => <li key={r.id}><RowCheckbox docCode={r.docCode} checked={sel.ids.has(r.id)} onChange={() => sel.toggle(r.id)} /></li>)}</ul>
      <SelectionBar items={rows.filter((r) => sel.ids.has(r.id))} onClear={sel.clear} />
    </div>
  );
}

function Paged({ rows }: { rows: Target[] }) {
  const [page, setPage] = useState(1);
  return (
    <>
      <button type="button" onClick={() => setPage((p) => p + 1)}>Next page</button>
      <Harness rows={rows} pageKey={`page=${page}`} />
    </>
  );
}

describe("selection (AC-1)", () => {
  const rows = [doc(1), doc(2), doc(3)];

  it("labels each checkbox with its DOC-ID and shows the bar with the count", async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} pageKey="a" />);
    expect(screen.queryByRole("button", { name: /Download zip/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("selection-count")).toHaveAttribute("aria-live", "polite");
    await user.click(screen.getByRole("checkbox", { name: "Select DOC-FY26-27-00002" }));
    expect(screen.getByTestId("selection-count")).toHaveTextContent("1 selected");
    for (const name of [/Download zip/, /Mark reviewed/, "Clear"]) expect(screen.getByRole("button", { name })).toBeEnabled();
  });

  it("Select all on this page selects every row, shows mixed when some are, and Clear empties it", async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} pageKey="a" />);
    const all = screen.getByRole("checkbox", { name: "Select all on this page" });
    await user.click(screen.getByRole("checkbox", { name: "Select DOC-FY26-27-00001" }));
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    await user.click(all);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 selected");
    expect(all).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("selection-count")).toHaveTextContent("");
    expect(all).not.toBeChecked();
  });

  it("a new page (or filter) starts with nothing selected (D2)", async () => {
    const user = userEvent.setup();
    render(<Paged rows={rows} />);
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 selected");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByTestId("selection-count")).toHaveTextContent("");
    expect(screen.getByRole("checkbox", { name: "Select DOC-FY26-27-00001" })).not.toBeChecked();
  });

  it("Download zip is disabled above 100 files, with the reason (AC-2)", async () => {
    const user = userEvent.setup();
    render(<Harness rows={Array.from({ length: 101 }, (_, i) => doc(i + 1))} pageKey="a" />);
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    const zip = screen.getByRole("button", { name: /Download zip/ });
    expect(zip).toBeDisabled();
    expect(zip).toHaveAccessibleDescription(ZIP_CAP_TEXT);
    expect(screen.getByRole("button", { name: /Mark reviewed/ })).toBeEnabled();
  });
});

describe("Mark reviewed (AC-3)", () => {
  it("confirm text counts what will be reviewed and why others are skipped", () => {
    expect(confirmText([doc(1), doc(2), doc(3, "in_inbox"), doc(4, "in_inbox")])).toBe("Mark 2 documents reviewed? 2 will be skipped (in inbox).");
    expect(confirmText([doc(1)])).toBe("Mark 1 document reviewed?");
    expect(confirmText([doc(1, "already_reviewed"), doc(2, "archived")])).toBe("None of the 2 documents can be marked reviewed (already reviewed, archived).");
  });

  it("result text", () => {
    expect(resultText([
      { id: "a", result: "reviewed", reason: null }, { id: "b", result: "skipped", reason: "in_inbox" },
    ])).toBe("1 reviewed · 1 skipped");
  });

  it("confirms, sends chunks of ≤ 200, then shows the result with skipped DOC-IDs; selection clears", async () => {
    const user = userEvent.setup();
    const rows = [...Array.from({ length: 249 }, (_, i) => doc(i + 1)), doc(250, "in_inbox")];
    markReviewedBulk.mockImplementation(async (ids: string[]) => ({
      ok: true,
      results: ids.map((id) => (id === rows[249].id || id === rows[10].id
        ? { id, result: "skipped", reason: id === rows[10].id ? "already_reviewed" : "in_inbox" }
        : { id, result: "reviewed", reason: null })),
    }));
    render(<Harness rows={rows} pageKey="a" />);
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: /Mark reviewed/ }));
    const dialog = screen.getByRole("dialog", { name: "Mark reviewed" });
    expect(within(dialog).getByText("Mark 249 documents reviewed? 1 will be skipped (in inbox).")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Mark 249 documents reviewed" }));
    await waitFor(() => expect(within(dialog).getByText("248 reviewed · 2 skipped")).toBeInTheDocument());
    expect(markReviewedBulk.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([200, 50]);
    const skipped = within(dialog).getByRole("list", { name: "Skipped documents" });
    expect(skipped).toHaveTextContent("DOC-FY26-27-00011 — already reviewed");
    expect(skipped).toHaveTextContent("DOC-FY26-27-00250 — in inbox");
    expect(refresh).toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("checkbox", { name: "Select all on this page" })).not.toBeChecked();
  });

  it("a failed chunk stops, says how many were handled, and keeps the selection", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 201 }, (_, i) => doc(i + 1));
    markReviewedBulk
      .mockResolvedValueOnce({ ok: true, results: rows.slice(0, 200).map((r) => ({ id: r.id, result: "reviewed", reason: null })) })
      .mockResolvedValueOnce({ ok: false, error: "Couldn't mark these documents reviewed. Please try again." });
    render(<Harness rows={rows} pageKey="a" />);
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: /Mark reviewed/ }));
    const dialog = screen.getByRole("dialog", { name: "Mark reviewed" });
    await user.click(within(dialog).getByRole("button", { name: "Mark 201 documents reviewed" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The first 200 documents were handled.");
    expect(within(dialog).getByText("200 reviewed")).toBeInTheDocument();
  });

  it("Cancel closes without calling the server", async () => {
    const user = userEvent.setup();
    render(<Harness rows={[doc(1)]} pageKey="a" />);
    await user.click(screen.getByRole("checkbox", { name: "Select DOC-FY26-27-00001" }));
    await user.click(screen.getByRole("button", { name: /Mark reviewed/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Mark reviewed" })).getByRole("button", { name: "Cancel" }));
    expect(markReviewedBulk).not.toHaveBeenCalled();
    expect(screen.getByTestId("selection-count")).toHaveTextContent("1 selected");
  });
});
