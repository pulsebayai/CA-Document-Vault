import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientDocument } from "@/lib/documents/queries";

// Client › In office (R1 feedback, Sankar 2026-11-12): the hard copies the firm holds for this client, any FY.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/custody/actions", () => ({ markCustody: vi.fn(), undoCustody: vi.fn() }));
vi.mock("@/lib/dispatch/actions", () => ({ readyOriginals: vi.fn(), createDispatch: vi.fn(), undoDispatchItem: vi.fn() }));
vi.mock("@/lib/review/actions", () => ({ markReviewed: vi.fn(), markNeedsCorrection: vi.fn(), undoReview: vi.fn() }));
vi.mock("@/app/(app)/documents/file-buttons", () => ({ FileButtons: () => null }));

const { InOfficeView, inOfficeDocuments } = await import("@/app/(app)/clients/[id]/in-office-view");

const C = "33333333-3333-4333-8333-333333333333";
const TODAY = "2026-11-12";
const doc = (over: Partial<ClientDocument>): ClientDocument => ({
  id: "d", docCode: "DOC-FY26-27-00001", typeName: "Sale deed", groupId: "g", groupName: "Property", groupSort: 1,
  periodLabel: null, periodStart: null, fyCode: "2026-27", receivedOn: "2026-10-01", receivedBy: "Asha", receivedAs: "hard_copy",
  returnable: true, correctionKind: null, versionCount: 1, current: null, proposed: false, fromLink: false, notPreferred: null,
  status: "reviewed", reviewedAt: "2026-10-02T04:00:00Z", reviewedByName: "Sankar", correctionReason: null,
  dispatchedOn: null, dispatchMethod: null, custody: null, inOfficeAt: null, ...over,
}) as ClientDocument;

afterEach(cleanup);

describe("inOfficeDocuments", () => {
  // R1 feedback round 2 (Sankar, 2026-11-12): "everything we physically hold" — every hard copy not in a live packet,
  // whether or not it has been reviewed, marked in office or tagged (13 AC-21 as changed).
  it("keeps every hard copy not in a live packet, any FY, any step, longest held first", () => {
    const docs = [
      doc({ id: "a", docCode: "DOC-FY25-26-00009", fyCode: "2025-26", custody: "in_office", inOfficeAt: "2026-09-01T04:00:00Z" }),
      doc({ id: "b", docCode: "DOC-FY26-27-00002", custody: "ready", inOfficeAt: "2026-10-20T04:00:00Z" }),
      doc({ id: "g", docCode: "DOC-FY26-27-00007", status: "needs_correction", custody: "in_office", inOfficeAt: "2026-10-10T04:00:00Z" }),
      doc({ id: "h", docCode: "DOC-FY26-27-00008", status: "received", custody: "in_office", inOfficeAt: "2026-10-12T04:00:00Z" }),
      // physically here too: reviewed but not yet placed, not yet reviewed, untagged (held since received on)
      doc({ id: "c", docCode: "DOC-FY26-27-00003", custody: null, receivedOn: "2026-10-01" }),
      doc({ id: "i", docCode: "DOC-FY26-27-00009", status: "received", reviewedAt: null, custody: null, receivedOn: "2026-10-15" }),
      doc({ id: "u", docCode: "DOC-FY26-27-00010", untagged: true, typeName: "Untagged document", status: "received", custody: null, receivedOn: "2026-08-15" }),
      // not held
      doc({ id: "e", docCode: "DOC-FY26-27-00005", custody: "ready", inOfficeAt: "2026-08-01T04:00:00Z", dispatchedOn: "2026-11-01", dispatchMethod: "courier" }), // left the office
      doc({ id: "f", docCode: "DOC-FY26-27-00006", receivedAs: "soft_copy", custody: null }),
    ];
    expect(inOfficeDocuments(docs).map((d) => d.id)).toEqual(["u", "a", "c", "g", "h", "i", "b"]);
  });
});

describe("InOfficeView", () => {
  it("lists the held copies with a count", () => {
    render(<InOfficeView clientId={C} clientName="Acme" today={TODAY}
      documents={[doc({ id: "a", custody: "in_office", inOfficeAt: "2026-10-01T04:00:00Z" }), doc({ id: "b", docCode: "DOC-FY26-27-00002", custody: "ready", inOfficeAt: "2026-10-05T04:00:00Z" })]} />);
    const list = screen.getByRole("list", { name: "Hard copies in office" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/2 documents/)).toBeTruthy();
  });

  it("says how many are not yet placed in office, and shows an untagged copy as Untagged", () => {
    render(<InOfficeView clientId={C} clientName="Acme" today={TODAY} documents={[
      doc({ id: "a", custody: "in_office", inOfficeAt: "2026-10-01T04:00:00Z" }),
      doc({ id: "c", docCode: "DOC-FY26-27-00003", custody: null }),
      doc({ id: "u", docCode: "DOC-FY26-27-00010", untagged: true, typeName: "Untagged document", status: "received", reviewedAt: null }),
    ]} />);
    expect(screen.getByText(/3 documents · 2 not yet placed in office/)).toBeTruthy();
    const list = screen.getByRole("list", { name: "Hard copies in office" });
    const row = within(list).getAllByRole("listitem").find((li) => li.textContent?.includes("DOC-FY26-27-00010"))!;
    expect(within(row).getByTestId("doc-state").textContent).toBe("Untagged");
    expect(within(row).queryByRole("button", { name: /Mark reviewed|Mark in office/ })).toBeNull();
  });

  it("says so when nothing is held, and links to All documents", () => {
    render(<InOfficeView clientId={C} clientName="Acme" today={TODAY} documents={[doc({ receivedAs: "soft_copy", custody: null })]} />);
    expect(screen.getByText("No hard copies in the office for this client.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all documents" }).getAttribute("href")).toBe(`/clients/${C}?tab=all`);
  });
});
