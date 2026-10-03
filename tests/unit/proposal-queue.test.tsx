import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, ProposalItem, ProposalQueue } from "@/lib/catalogue/queries";

// Feature 05 step 4 — the "Proposed by staff" decision queue (spec AC-1, AC-8, AC-9, AC-11). The dialogs' server
// actions are mocked; the database rules are proven in tests/rls/type-governance.test.ts.

vi.mock("@/lib/catalogue/actions", () => ({
  addFinancialYear: vi.fn(), moveGroup: vi.fn(), saveDocGroup: vi.fn(), saveDocType: vi.fn(),
  setGroupEnabledForNew: vi.fn(), setTypeReminders: vi.fn(),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const previewDecision = vi.fn();
const mergeProposedType = vi.fn();
const approveProposedType = vi.fn();
const searchMergeTargets = vi.fn();
vi.mock("@/lib/catalogue/governance", () => ({
  previewDecision: (...a: unknown[]) => previewDecision(...a), approveProposedType: (...a: unknown[]) => approveProposedType(...a),
  editAndApproveType: vi.fn(), mergeProposedType: (...a: unknown[]) => mergeProposedType(...a), rejectProposedType: vi.fn(),
  searchMergeTargets: (...a: unknown[]) => searchMergeTargets(...a),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { CatalogueView } = await import("@/app/(app)/settings/catalogue/catalogue-view");
const { previewLines } = await import("@/app/(app)/settings/catalogue/proposal-dialogs");

// jsdom has no <dialog> methods.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

const catalogue: Catalogue = {
  groups: [{ id: "g1", name: "Payroll", sort: 10, active: true, enabledForNewClients: true, types: [] }],
  firmRecords: [], years: [],
};
const item = (over: Partial<ProposalItem>): ProposalItem => ({
  typeId: "t1", typeIds: ["t1", "t2"], name: "Salary sheet", groupId: "g1", groupName: "Payroll", proposedBy: ["Priya", "Arun"],
  proposedAt: "2026-10-01T05:30:00Z", clientCount: 2, clients: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Bharat" }], documentCount: 3, ...over,
});
const queue: ProposalQueue = { waiting: 2, items: [item({}), item({ typeId: "t3", typeIds: ["t3"], name: "Visiting cards", clientCount: 1, clients: [{ id: "c1", name: "Acme" }], documentCount: 0, proposedBy: ["Priya"] })] };

describe("the queue (AC-1)", () => {
  it("one row per item: name, group, proposers, date, documents, clients and the four decisions in the mockup's order", () => {
    render(<CatalogueView catalogue={catalogue} canEdit canAddFy={false} proposed={queue} />);
    const panel = screen.getByRole("region", { name: /Proposed by staff/ });
    expect(panel).toHaveTextContent("2 waiting");
    const rows = within(within(panel).getByRole("list", { name: "Proposed types" })).getAllByRole("listitem").filter((li) => li.parentElement?.getAttribute("aria-label") === "Proposed types");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Payroll · by Priya, Arun · 1 Oct 2026 · 3 documents");
    expect(within(rows[0]).getByText("Used on 2 clients")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "Bharat" })).toHaveAttribute("href", "/clients/c2");
    const names = within(rows[0]).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual(["Approve Salary sheet", "Edit and approve Salary sheet", "Merge Salary sheet into an approved type", "Reject"]);
  });

  it("Reject is disabled with the reason when the item has documents (AC-9); enabled without", () => {
    render(<CatalogueView catalogue={catalogue} canEdit canAddFy={false} proposed={queue} />);
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();
    expect(reject).toHaveAccessibleDescription("3 documents use this type. Merge it into an approved type instead.");
    expect(screen.getByRole("button", { name: "Reject Visiting cards" })).toBeEnabled();
  });

  it("empty: 'No proposed types waiting.'; Staff/Limited get no panel", () => {
    render(<CatalogueView catalogue={catalogue} canEdit canAddFy={false} proposed={{ waiting: 0, items: [] }} />);
    expect(screen.getByText("No proposed types waiting.")).toBeInTheDocument();
    cleanup();
    render(<CatalogueView catalogue={catalogue} canEdit={false} canAddFy={false} />);
    expect(screen.queryByRole("region", { name: /Proposed by staff/ })).toBeNull();
  });
});

describe("dialogs (AC-8, AC-11)", () => {
  it("Merge: pick a target, see what will happen, merge", async () => {
    searchMergeTargets.mockResolvedValue([{ id: "x", name: "Salary register / attendance", groupName: "Payroll" }]);
    previewDecision.mockResolvedValue({ ok: true, counts: { documents: 3, clients: 2, planAdded: 1, received: 1 }, conflicts: [] });
    mergeProposedType.mockResolvedValue({ ok: true, message: "Merged: 3 documents moved." });
    render(<CatalogueView catalogue={catalogue} canEdit canAddFy={false} proposed={queue} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge Salary sheet into an approved type" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Salary register/ }));
    const list = await screen.findByRole("list", { name: "What will happen" });
    expect(list).toHaveTextContent("3 documents on 2 clients move to Salary register / attendance.");
    expect(list).toHaveTextContent("Review and dispatch states stay.");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(mergeProposedType).toHaveBeenCalledWith({ typeId: "t1", targetId: "x", comment: "" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("Merge: a period conflict lists the documents and blocks the button (AC-7)", async () => {
    searchMergeTargets.mockResolvedValue([{ id: "y", name: "Bank balance confirmation", groupName: "Banking" }]);
    previewDecision.mockResolvedValue({ ok: true, counts: { documents: 3, clients: 2, planAdded: 0, received: 0 }, conflicts: [{ documentId: "d1", docCode: "DOC-FY26-27-00004" }] });
    render(<CatalogueView catalogue={catalogue} canEdit canAddFy={false} proposed={queue} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge Salary sheet into an approved type" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank balance/ }));
    expect(await screen.findByRole("link", { name: "DOC-FY26-27-00004" })).toHaveAttribute("href", "/documents/d1");
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("Approve: someone else decided first — the message, Close instead of Approve, and a refresh (AC-11)", async () => {
    previewDecision.mockResolvedValue({ ok: true, counts: { documents: 3, clients: 2, planAdded: 1, received: 0 }, conflicts: [] });
    approveProposedType.mockResolvedValue({ ok: false, stale: true, error: "Already decided by Raja. Close to see the updated list." });
    render(<CatalogueView catalogue={catalogue} canEdit canAddFy={false} proposed={queue} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve Salary sheet" }));
    expect(await screen.findByRole("list", { name: "What will happen" })).toHaveTextContent("The proposals for the other 1 client are merged into it.");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already decided by Raja.");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // The page refreshes when the dialog closes, not before: refreshing first unmounted the dialog and its message
    // (pre-PR review I-2).
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("previewLines (AC-8 wording)", () => {
  it("merge and approve, with plan adds and received counts", () => {
    expect(previewLines("merge", { documents: 12, clients: 2, planAdded: 1, received: 3 }, { name: "Salary sheet", clientCount: 2 }, "Payroll register")).toEqual([
      "12 documents on 2 clients move to Payroll register.", "Review and dispatch states stay.",
      "Payroll register is added to 1 client’s plan.", "3 documents will count as received for their expected items.",
    ]);
    expect(previewLines("approve", { documents: 1, clients: 1, planAdded: 0, received: 0 }, { name: "Gate passes", clientCount: 1 })).toEqual([
      "“Gate passes” becomes an approved type, offered for every client.", "1 document stays filed under it; review and dispatch states stay.",
    ]);
  });
});
