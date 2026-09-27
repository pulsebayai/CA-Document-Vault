import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, CatalogueType } from "@/lib/catalogue/queries";

// Server actions can't run in jsdom; the view only needs their references.
vi.mock("@/lib/catalogue/actions", () => ({
  addFinancialYear: vi.fn(), moveGroup: vi.fn(), saveDocGroup: vi.fn(), saveDocType: vi.fn(),
  setGroupEnabledForNew: vi.fn(), setTypeReminders: vi.fn(),
}));
afterEach(cleanup); // RTL auto-cleanup needs vitest globals, which this repo does not enable
const { CatalogueView } = await import("@/app/(app)/settings/catalogue/catalogue-view");

const type = (over: Partial<CatalogueType>): CatalogueType => ({
  id: crypto.randomUUID(), docGroupId: "g1", name: "Sales invoices", aliases: [], periodKind: "month", defaultFrequency: "monthly",
  source: "client", usedFor: "GSTR-1", askAfterMonths: 1, askDay: 1, overdueAfterMonths: 1, overdueDay: 5, reminders: true, active: true, usedBy: 3,
  ...over,
});
const catalogue: Catalogue = {
  groups: [
    { id: "g1", name: "GST", sort: 10, active: true, enabledForNewClients: true, types: [
      type({}), type({ name: "GST notice", periodKind: "none", defaultFrequency: "as_needed", askAfterMonths: null, askDay: null, overdueAfterMonths: null, overdueDay: null, reminders: false, usedBy: 1, usedFor: null }),
    ] },
    { id: "g2", name: "Old group", sort: 20, active: false, enabledForNewClients: false, types: [] },
  ],
  firmRecords: [{ ...type({ name: "GST returns filed", source: "firm", defaultFrequency: "as_needed", aliases: ["GSTR-1", "GSTR-3B"] }), groupName: "GST" }],
  years: [{ id: "y1", code: "2025-26", startDate: "2025-04-01", endDate: "2026-03-31" }, { id: "y2", code: "2026-27", startDate: "2026-04-01", endDate: "2027-03-31" }],
};

describe("CatalogueView (spec 02 AC-1, AC-4, AC-6)", () => {
  it("shows groups, types with schedule, usage, firm records and FYs", () => {
    render(<CatalogueView catalogue={catalogue} canEdit={false} canAddFy={false} />);
    const gst = screen.getByRole("region", { name: "GST" });
    const row = within(gst).getByRole("row", { name: /Sales invoices/ });
    expect(row).toHaveTextContent("Monthly");
    expect(row).toHaveTextContent("Ask 1st of the next month · overdue from 5th of the next month");
    expect(row).toHaveTextContent("3 clients");
    expect(within(gst).getByRole("row", { name: /GST notice/ })).toHaveTextContent("1 client");
    const firm = screen.getByRole("region", { name: "Firm records" });
    expect(within(firm).getByRole("row", { name: /GST returns filed/ })).toHaveTextContent("GSTR-1, GSTR-3B");
    expect(within(firm).queryByText("Reminders")).toBeNull(); // no schedule columns for firm records
    expect(screen.getByText("FY 2026-27")).toBeInTheDocument();
    expect(screen.getByText(/Existing clients keep their own schedule/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Old group" })).toHaveTextContent("Inactive");
  });

  it("read-only for Staff/Limited: no edit controls, switches disabled", () => {
    render(<CatalogueView catalogue={catalogue} canEdit={false} canAddFy={false} />);
    expect(screen.getByRole("note")).toHaveTextContent("An Admin or Manager can change it.");
    expect(screen.queryByRole("button", { name: /^Edit|Add|Move/ })).toBeNull();
    for (const s of screen.getAllByRole("switch")) expect(s).toBeDisabled();
  });

  it("editable for Admin/Manager; reminders switch disabled for 'as needed' types", () => {
    render(<CatalogueView catalogue={catalogue} canEdit canAddFy />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Sales invoices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add type to GST" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit group GST" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "GST: enabled for new clients" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Reminders for Sales invoices" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Reminders for GST notice" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add next financial year" })).toBeInTheDocument();
  });
});
