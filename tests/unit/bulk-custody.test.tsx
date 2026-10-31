import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Feature 13 (spec AC-9) — bulk Mark in office / Ready to dispatch from 08's selection bar: confirm → chunks of ≤ 200
// → result with each skipped DOC-ID and why. The SQL side (skip reasons, 200 < 5 s) is tests/rls/custody.test.ts.

const markCustodyBulk = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/bulk/actions", () => ({ markCustodyBulk: (...a: unknown[]) => markCustodyBulk(...a), markReviewedBulk: vi.fn(), getZipManifest: vi.fn(), getFileLinks: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
// jsdom has no showModal/close on <dialog>.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };

const { SelectionBar } = await import("@/components/selection-bar");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: id(i + 1), docCode: `DOC-FY26-27-${String(i + 1).padStart(5, "0")}`, skip: null }));

describe("bulk custody (AC-9)", () => {
  it("Mark in office: confirms, sends chunks of ≤ 200, lists skipped DOC-IDs with the reason, and clears the selection", async () => {
    const items = targets(250);
    markCustodyBulk.mockImplementation(async (ids: string[]) => ({ ok: true, done: ids.filter((x) => x !== id(3)), skipped: ids.includes(id(3)) ? [{ id: id(3), reason: "NOT_REVIEWED" }] : [] }));
    const onClear = vi.fn();
    render(<SelectionBar items={items} onClear={onClear} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark in office" }));
    const dialog = screen.getByRole("dialog", { name: "Mark in office" });
    expect(dialog).toHaveTextContent("Mark 250 documents in office?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark in office: 250 documents" }));
    expect(await within(dialog).findByText("249 marked in office · 1 skipped")).toBeInTheDocument();
    expect(markCustodyBulk.mock.calls.map((c) => [c[0].length, c[1]])).toEqual([[200, "in_office"], [50, "in_office"]]);
    expect(within(dialog).getByRole("list", { name: "Skipped documents" })).toHaveTextContent("DOC-FY26-27-00003 — not reviewed yet");
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("Ready to dispatch sends the ready step; a failed chunk says how many were handled", async () => {
    markCustodyBulk.mockResolvedValueOnce({ ok: true, done: targets(200).map((t) => t.id), skipped: [] })
      .mockResolvedValueOnce({ ok: false, error: "Couldn't update these documents. Please try again." });
    render(<SelectionBar items={targets(210)} onClear={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Ready to dispatch" }));
    const dialog = screen.getByRole("dialog", { name: "Ready to dispatch" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Ready to dispatch: 210 documents" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The first 200 documents were handled.");
    expect(markCustodyBulk.mock.calls[0][1]).toBe("ready");
  });

  it("Cancel closes without calling the server", async () => {
    render(<SelectionBar items={targets(2)} onClear={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark in office" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Mark in office" })).getByRole("button", { name: "Cancel" }));
    expect(markCustodyBulk).not.toHaveBeenCalled();
  });
});
