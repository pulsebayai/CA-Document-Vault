import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Feature 12, spec AC-21: Needs correction asks for the kind (Wrong file | Wrong details) and the reason.
// The database side (kind stored, KIND_INVALID) is in tests/rls/correction-kind.test.ts.

const markNeedsCorrection = vi.fn<(input: unknown) => Promise<{ ok: true; message: string }>>(async () => ({ ok: true, message: "Marked as needing correction." }));
vi.mock("@/lib/review/actions", () => ({ markReviewed: vi.fn(), markNeedsCorrection, undoReview: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
// jsdom has no showModal/close on <dialog>.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };

const { ReviewControls } = await import("@/app/(app)/clients/[id]/review-controls");
const D = "00000000-0000-4000-8000-0000000000d1";
const C = "00000000-0000-4000-8000-0000000000c1";

async function openDialog() {
  render(<ReviewControls documentId={D} clientId={C} label="Bank statement DOC-FY26-27-00009" onMessage={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /^Needs correction: Bank statement/ }));
  return screen.getByRole("dialog", { name: /Needs correction/ });
}

describe("Needs correction kind (AC-21)", () => {
  it("offers Wrong file and Wrong details, none chosen", async () => {
    const dialog = await openDialog();
    const group = within(dialog).getByRole("group", { name: "What is wrong?" });
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    expect(within(group).getByRole("radio", { name: /Wrong file/ })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: /Wrong details/ })).toBeInTheDocument();
  });

  it("with a reason but no kind, asks for the kind and saves nothing", async () => {
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Wrong month");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark needs correction" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Choose wrong file or wrong details.");
    expect(markNeedsCorrection).not.toHaveBeenCalled();
  });

  it("sends the chosen kind with the reason", async () => {
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Wrong details/ }));
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Wrong month");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark needs correction" }));
    await waitFor(() => expect(markNeedsCorrection).toHaveBeenCalledWith({ id: D, clientId: C, reason: "Wrong month", kind: "details" }));
  });
});
