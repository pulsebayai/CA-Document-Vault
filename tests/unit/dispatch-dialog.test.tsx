import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientDocument } from "@/lib/documents/queries";

// Feature 07 step 5 — the dispatch dialog (AC-8, AC-9) and the Client › Documents row (AC-11, AC-12).
// The rules themselves are enforced by create_dispatch (tests/rls/review-dispatch.test.ts).

const readyOriginals = vi.fn();
const createDispatch = vi.fn();
vi.mock("@/lib/dispatch/actions", () => ({ readyOriginals, createDispatch, undoDispatchItem: vi.fn() }));
const markReviewed = vi.fn(async () => ({ ok: true as const, message: "Marked reviewed." }));
vi.mock("@/lib/review/actions", () => ({ markReviewed, markNeedsCorrection: vi.fn(), undoReview: vi.fn() }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/(app)/documents/file-buttons", () => ({ FileButtons: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { DispatchForm } = await import("@/app/(app)/clients/[id]/dispatch-dialog");
const { DocumentRow } = await import("@/app/(app)/clients/[id]/document-row");

const CLIENT = "00000000-0000-4000-8000-000000000001";
const O1 = "00000000-0000-4000-8000-0000000000a1";
const O2 = "00000000-0000-4000-8000-0000000000a2";
const TODAY = "2026-10-01";
const originals = [
  { id: O1, docCode: "DOC-FY26-27-00001", typeName: "Form 16", periodLabel: "FY 2025-26", receivedOn: "2026-09-01" },
  { id: O2, docCode: "DOC-FY26-27-00002", typeName: "Share certificate", periodLabel: null, receivedOn: "2026-09-21" },
];

describe("DispatchForm (AC-8, AC-9)", () => {
  it("lists the client's ready originals with this one ticked, and held days", async () => {
    readyOriginals.mockResolvedValue({ ok: true, originals });
    render(<DispatchForm clientId={CLIENT} documentId={O1} today={TODAY} close={vi.fn()} onDone={vi.fn()} />);
    const one = await screen.findByRole("checkbox", { name: /Form 16 · FY 2025-26/ });
    expect(one).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Share certificate/ })).not.toBeChecked();
    expect(screen.getByText(/DOC-FY26-27-00001 · held 30 days/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark 1 dispatched" })).toBeEnabled();
    expect(screen.queryByLabelText(/Courier \(optional\)/)).not.toBeInTheDocument();
  });

  it("asks for courier details only for Courier, and saves one packet with every ticked original", async () => {
    const user = userEvent.setup();
    readyOriginals.mockResolvedValue({ ok: true, originals });
    createDispatch.mockResolvedValue({ ok: true, message: "Marked 2 dispatched." });
    const onDone = vi.fn();
    const close = vi.fn();
    render(<DispatchForm clientId={CLIENT} documentId={O1} today={TODAY} close={close} onDone={onDone} />);
    await user.click(await screen.findByRole("checkbox", { name: /Share certificate/ }));
    await user.click(screen.getByRole("radio", { name: "Courier" }));
    await user.type(screen.getByLabelText(/Courier \(optional\)/), "DTDC");
    await user.type(screen.getByLabelText(/Tracking number/), "D123");
    await user.type(screen.getByLabelText("Recipient"), "R Kumar");
    await user.click(screen.getByRole("button", { name: "Mark 2 dispatched" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("Marked 2 dispatched."));
    expect(createDispatch).toHaveBeenCalledWith({
      clientId: CLIENT, documentIds: [O1, O2], dispatchedOn: TODAY, method: "courier", courierName: "DTDC", trackingNo: "D123",
      recipientName: "R Kumar", latestReceivedOn: "2026-09-21",
    });
    expect(close).toHaveBeenCalled();
  });

  it("when an original is no longer ready, re-lists the valid ones and drops its tick (AC-9)", async () => {
    const user = userEvent.setup();
    readyOriginals.mockResolvedValue({ ok: true, originals });
    createDispatch.mockResolvedValue({ ok: false, stale: true, fieldErrors: {}, error: "Some originals are no longer ready to dispatch.", originals: [originals[1]] });
    render(<DispatchForm clientId={CLIENT} documentId={O1} today={TODAY} close={vi.fn()} onDone={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: /Share certificate/ }));
    await user.type(screen.getByLabelText("Recipient"), "R Kumar");
    await user.click(screen.getByRole("button", { name: "Mark 2 dispatched" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer ready/);
    expect(screen.queryByRole("checkbox", { name: /Form 16/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark 1 dispatched" })).toBeEnabled();
  });

  it("shows field errors from the server next to their fields", async () => {
    const user = userEvent.setup();
    readyOriginals.mockResolvedValue({ ok: true, originals });
    createDispatch.mockResolvedValue({ ok: false, stale: false, error: "Check the highlighted fields.", fieldErrors: { recipientName: "Enter who received it." } });
    render(<DispatchForm clientId={CLIENT} documentId={O1} today={TODAY} close={vi.fn()} onDone={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Mark 1 dispatched" }));
    expect(await screen.findByText("Enter who received it.")).toBeInTheDocument();
    expect(screen.getByLabelText("Recipient")).toHaveAttribute("aria-invalid", "true");
  });

  it("empty state", async () => {
    readyOriginals.mockResolvedValue({ ok: true, originals: [] });
    render(<DispatchForm clientId={CLIENT} documentId={O1} today={TODAY} close={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByText("No originals are ready to dispatch for this client.")).toBeInTheDocument();
  });
});

describe("DocumentRow (AC-11, AC-12)", () => {
  const doc = (over: Partial<ClientDocument> = {}): ClientDocument => ({
    id: O1, docCode: "DOC-FY26-27-00001", typeName: "Form 16", groupId: "g", groupName: "Income Tax", groupSort: 1,
    periodLabel: "FY 2025-26", periodStart: "2025-04-01", fyCode: "2026-27", receivedOn: "2026-09-01", receivedBy: "Priya",
    receivedAs: "hard_copy", versionCount: 1, current: null, proposed: false,
    status: "received", reviewedAt: null, reviewedByName: null, correctionReason: null, dispatchedOn: null, dispatchMethod: null, ...over,
  });
  const row = (d: ClientDocument) => { render(<ul><DocumentRow d={d} clientId={CLIENT} today={TODAY} /></ul>); return screen.getByRole("listitem"); };

  it("To review: state text + Mark reviewed + Needs correction…", async () => {
    const user = userEvent.setup();
    const li = row(doc());
    expect(li).toHaveTextContent("To review");
    await user.click(within(li).getByRole("button", { name: /Mark reviewed/ }));
    expect(markReviewed).toHaveBeenCalledWith({ id: O1, clientId: CLIENT });
    expect(within(li).getByRole("button", { name: /^Needs correction: Form 16/ })).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("Needs correction shows the reason and keeps the review actions", () => {
    const li = row(doc({ status: "needs_correction", correctionReason: "Unsigned", reviewedByName: "Ravi", reviewedAt: "2026-09-02T06:00:00Z" }));
    expect(li).toHaveTextContent("Needs correction · Unsigned");
    expect(within(li).getByRole("button", { name: /Mark reviewed/ })).toBeInTheDocument();
  });

  it("Reviewed copy: text only, no action, no held days", () => {
    const li = row(doc({ status: "reviewed", reviewedByName: "Ravi", reviewedAt: "2026-09-02T06:00:00Z" }));
    expect(li).toHaveTextContent("Reviewed 2 Sep by Ravi");
    expect(within(li).queryByRole("button")).toBeNull();
    expect(li).not.toHaveTextContent("Held");
  });

  it("Ready original: Mark dispatched + Held N days", () => {
    const li = row(doc({ receivedAs: "original", status: "reviewed", reviewedByName: "Ravi", reviewedAt: "2026-09-02T06:00:00Z" }));
    expect(li).toHaveTextContent("Ready to dispatch");
    expect(li).toHaveTextContent("Held 30 days");
    expect(within(li).getByRole("button", { name: /Mark dispatched/ })).toBeInTheDocument();
  });

  it("Dispatched original: dispatch text, no action, no held days", () => {
    const li = row(doc({ receivedAs: "original", status: "reviewed", dispatchedOn: "2026-09-12", dispatchMethod: "hand_delivery" }));
    expect(li).toHaveTextContent("Dispatched 12 Sep · Hand delivery");
    expect(within(li).queryByRole("button")).toBeNull();
    expect(li).not.toHaveTextContent("Held");
  });
});
