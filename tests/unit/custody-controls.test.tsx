import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientDocument } from "@/lib/documents/queries";
import type { CustodyPanelView } from "@/app/(app)/documents/custody-controls";

// Feature 13 — the custody click on Client › Documents rows and the document page's Custody card (spec AC-4, AC-9,
// AC-10, S3, P1). Server actions and the router are mocked; the SQL side is tests/rls/custody.test.ts.

const markCustody = vi.fn();
const undoCustody = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/custody/actions", () => ({ markCustody: (i: unknown) => markCustody(i), undoCustody: (i: unknown) => undoCustody(i) }));
vi.mock("@/lib/review/actions", () => ({ markReviewed: vi.fn(), markNeedsCorrection: vi.fn(), undoReview: vi.fn() }));
vi.mock("@/lib/dispatch/actions", () => ({ readyOriginals: vi.fn(async () => ({ ok: true, originals: [] })), createDispatch: vi.fn(), undoDispatchItem: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/(app)/documents/file-buttons", () => ({ FileButtons: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { DocumentRow } = await import("@/app/(app)/clients/[id]/document-row");
const { CustodyPanel } = await import("@/app/(app)/documents/custody-controls");

const D = "00000000-0000-4000-8000-0000000000d1";
const C = "00000000-0000-4000-8000-0000000000c1";
const TODAY = "2026-10-31";
const doc = (over: Partial<ClientDocument> = {}): ClientDocument => ({
  id: D, docCode: "DOC-FY26-27-00009", typeName: "Bank statement", groupId: "g", groupName: "Banking", groupSort: 4,
  periodLabel: "Apr 2026", periodStart: "2026-04-01", fyCode: "2026-27", receivedOn: "2026-09-01", receivedBy: "Priya",
  receivedAs: "hard_copy", versionCount: 1, current: null, proposed: false,
  status: "reviewed", reviewedAt: "2026-09-02T06:00:00Z", reviewedByName: "Ravi", correctionReason: null,
  dispatchedOn: null, dispatchMethod: null, custody: null, ...over,
});
const row = (d: ClientDocument) => { render(<ul><DocumentRow d={d} clientId={C} today={TODAY} /></ul>); return screen.getByRole("listitem"); };

describe("row custody click (AC-9)", () => {
  it("a reviewed hard copy offers Mark in office; the click calls set_custody and announces the result", async () => {
    markCustody.mockResolvedValue({ ok: true, message: "Marked in office.", done: [D], skipped: [] });
    const li = row(doc());
    await userEvent.click(within(li).getByRole("button", { name: /^Mark in office: Bank statement/ }));
    expect(markCustody).toHaveBeenCalledWith({ ids: [D], step: "in_office", clientId: C });
    expect(await within(li).findByRole("status")).toHaveTextContent("Marked in office.");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("a returnable copy in office offers Ready to dispatch; a plain one in office offers nothing (the firm keeps it)", () => {
    const li = row(doc({ returnable: true, custody: "in_office", inOfficeAt: "2026-10-20T06:00:00Z" }));
    expect(li).toHaveTextContent("Document in office");
    expect(within(li).getByRole("button", { name: /^Ready to dispatch: Bank statement/ })).toBeInTheDocument();
    cleanup();
    const plain = row(doc({ custody: "in_office", inOfficeAt: "2026-10-20T06:00:00Z" }));
    expect(within(plain).queryByRole("button", { name: /Mark in office|Ready to dispatch/ })).toBeNull();
  });

  it("S1: a Needs-correction hard copy offers Mark in office next to its review actions (pre-PR review nit 1)", () => {
    const li = row(doc({ status: "needs_correction", correctionReason: "Wrong year" }));
    expect(within(li).getByRole("button", { name: /^Mark reviewed/ })).toBeInTheDocument();
    expect(within(li).getByRole("button", { name: /^Mark in office: Bank statement/ })).toBeInTheDocument();
  });

  it("a skipped document says why", async () => {
    markCustody.mockResolvedValue({ ok: true, message: "0 marked in office · 1 skipped (not reviewed yet).", done: [], skipped: [{ id: D, reason: "NOT_REVIEWED" }] });
    const li = row(doc());
    await userEvent.click(within(li).getByRole("button", { name: /^Mark in office/ }));
    expect(await within(li).findByRole("status")).toHaveTextContent("Not changed — not reviewed yet.");
  });

  it("P1: \"In office N days\" shows only past 30 days; 07's Held N days stays", () => {
    const li = row(doc({ returnable: true, custody: "in_office", inOfficeAt: "2026-09-20T06:00:00Z" }));
    expect(li).toHaveTextContent("In office 41 days");
    expect(li).toHaveTextContent(/Held \d+ days/);
    cleanup();
    expect(row(doc({ returnable: true, custody: "in_office", inOfficeAt: "2026-10-05T06:00:00Z" }))).not.toHaveTextContent("In office 26 days");
  });
});

describe("document page Custody card (AC-4, AC-9, S3)", () => {
  const view = (over: Partial<CustodyPanelView> = {}): CustodyPanelView => ({
    step: "in_office", inOfficeText: "20 Oct 2026", inOfficeBy: "Priya", readyText: null, readyBy: null, returnable: true,
    next: "ready", hint: null, canUndo: true, inOfficeDays: 11, ...over,
  });

  it("shows the step with who and when, the next click and Undo (no reason asked)", async () => {
    undoCustody.mockResolvedValue({ ok: true, message: "Undone." });
    const { container } = render(<CustodyPanel documentId={D} clientId={C} label="Bank statement" view={view()} />);
    expect(screen.getByTestId("custody-state")).toHaveTextContent("Document in office since 20 Oct 2026 by Priya");
    expect(screen.getByRole("button", { name: "Ready to dispatch: Bank statement" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo Document in office: Bank statement" }));
    expect(undoCustody).toHaveBeenCalledWith({ id: D, clientId: C });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent("Back to Not in office yet.");
    const r = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("a migrated step says when custody started; a plain copy says the firm keeps it", () => {
    render(<CustodyPanel documentId={D} clientId={C} label="x" view={view({ inOfficeBy: null, returnable: false, next: null })} />);
    expect(screen.getByTestId("custody-state")).toHaveTextContent("Document in office since 20 Oct 2026 (set when custody started) — the firm keeps it");
  });

  it("Ready shows both dates; with no step it says Not in office yet and offers Mark in office", () => {
    render(<CustodyPanel documentId={D} clientId={C} label="x" view={view({ step: "ready", readyText: "25 Oct 2026", readyBy: "Ravi", next: null })} />);
    expect(screen.getByTestId("custody-state")).toHaveTextContent("Ready to dispatch since 25 Oct 2026 by Ravi");
    expect(screen.getByText(/In office since 20 Oct 2026 by Priya/)).toBeInTheDocument();
    cleanup();
    render(<CustodyPanel documentId={D} clientId={C} label="x" view={view({ step: null, inOfficeText: null, inOfficeBy: null, next: "in_office", canUndo: false })} />);
    expect(screen.getByTestId("custody-state")).toHaveTextContent("Not in office yet");
    expect(screen.getByRole("button", { name: "Mark in office: x" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });
});
