import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpectedItem } from "@/lib/expected/shape";

// Feature 04 step 5 — Client › Expected (spec AC-13; actions AC-8 … AC-11). Role rules are enforced by SQL + RLS
// (tests/rls/expected-*.test.ts); this checks which controls the view offers and the filters.

const reopen = vi.fn(async () => ({ ok: true as const, message: "Reopened." }));
vi.mock("@/lib/expected/actions", () => ({ waiveExpected: vi.fn(), undoWaiveExpected: vi.fn(), reopenExpected: reopen }));
afterEach(() => { cleanup(); reopen.mockClear(); });
const { ExpectedView, uploadHref, itemLabel } = await import("@/app/(app)/clients/[id]/expected-view");

const CLIENT = "00000000-0000-4000-8000-000000000001";
const item = (over: Partial<ExpectedItem>): ExpectedItem => ({
  id: crypto.randomUUID(), groupId: "g1", groupName: "GST", typeId: "t1", typeName: "Sales invoices / sales register",
  periodId: "p9", periodLabel: "Sep 2026", fyId: "fy27", registration: null, registrationId: null, status: "pending",
  state: { kind: "overdue", text: "Overdue · 3 days late", daysLate: 3 }, open: true, assignedTo: "Asha",
  waivedBy: null, waivedAt: null, manualWaiver: false, ...over,
});
const items = [
  item({}),
  item({ periodId: "p8", periodLabel: "Aug 2026", status: "received", state: { kind: "received", text: "Received 3 Sep · DOC-FY26-27-00001" }, open: false }),
  item({ periodId: "p7", periodLabel: "Jul 2026", status: "waived", state: { kind: "not_needed", text: "Not needed · Shop closed" }, open: false,
    waivedBy: "Ravi", waivedAt: "2026-08-10T06:00:00Z", manualWaiver: true }),
  item({ groupId: "g2", groupName: "Banking", typeId: "t2", typeName: "Bank statement", state: { kind: "due", text: "Due 6 Oct", dueBy: "2026-10-06" } }),
  item({ groupId: "g2", groupName: "Banking", typeId: "t2", typeName: "Bank statement", periodId: "p0", periodLabel: "Mar 2026", fyId: "fy26" }),
];
const fys = [{ id: "fy27", code: "2026-27" }, { id: "fy26", code: "2025-26" }];
const all = { canAct: true, canWaive: true, canUndo: true };

describe("ExpectedView (AC-13)", () => {
  it("defaults to Open items of the current FY, grouped by group", () => {
    render(<ExpectedView clientId={CLIENT} items={items} fys={fys} currentFyId="fy27" perms={all} />);
    const gst = screen.getByRole("list", { name: "GST expected documents" });
    expect(within(gst).getAllByRole("listitem")).toHaveLength(1);
    expect(within(gst).getByRole("listitem")).toHaveTextContent("Sales invoices / sales register · Sep 2026");
    expect(within(gst).getByRole("listitem")).toHaveTextContent("Overdue · 3 days late");
    // Review Important 2: the still-open Mar 2026 item (FY 2025-26) is listed under the current FY too, marked with its FY.
    const banking = within(screen.getByRole("list", { name: "Banking expected documents" })).getAllByRole("listitem");
    expect(banking).toHaveLength(2);
    expect(banking.find((li) => li.textContent?.includes("Mar 2026"))).toHaveTextContent("Bank statement · Mar 2026 · FY 2025-26");
  });

  it("status and FY filters, and the empty state", async () => {
    const user = userEvent.setup();
    render(<ExpectedView clientId={CLIENT} items={items} fys={fys} currentFyId="fy27" perms={all} />);
    await user.selectOptions(screen.getByLabelText("Status"), "Not needed");
    const row = within(screen.getByRole("list", { name: "GST expected documents" })).getByRole("listitem");
    expect(row).toHaveTextContent("Not needed · Shop closed");
    expect(row).toHaveTextContent("Ravi, 10 Aug 2026");
    await user.selectOptions(screen.getByLabelText("Status"), "Open");
    await user.selectOptions(screen.getByLabelText("Group"), "GST");
    await user.selectOptions(screen.getByLabelText("Financial year"), "FY 2025-26");
    expect(screen.getByText("Nothing outstanding for FY 2025-26 in this group")).toBeInTheDocument();
  });

  it("offers Upload + Waive on open items, Reopen on received, Undo on not needed", async () => {
    const user = userEvent.setup();
    render(<ExpectedView clientId={CLIENT} items={items} fys={fys} currentFyId="fy27" perms={all} />);
    await user.selectOptions(screen.getByLabelText("Status"), "All");
    expect(screen.getByRole("link", { name: "Upload Sales invoices / sales register · Sep 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waive Sales invoices / sales register · Sep 2026" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Waive .*Aug 2026/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo not needed for Sales invoices / sales register · Jul 2026" })).toBeInTheDocument();

    // Reopen asks first ("Still waiting for more?"), then calls the action.
    await user.click(screen.getByRole("button", { name: "Reopen Sales invoices / sales register · Aug 2026" }));
    expect(screen.getByText("Still waiting for more?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(reopen).toHaveBeenCalledWith({ id: items[1].id, clientId: CLIENT });
    expect(await screen.findByText("Reopened.")).toBeInTheDocument();
  });

  it("Limited: no Waive or Undo; archived client: no actions at all", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ExpectedView clientId={CLIENT} items={items} fys={fys} currentFyId="fy27" perms={{ canAct: true, canWaive: false, canUndo: false }} />);
    await user.selectOptions(screen.getByLabelText("Status"), "All");
    expect(screen.queryByRole("button", { name: /^Waive/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: /^Upload/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Reopen/ })).toBeInTheDocument(); // AC-11: anyone who can see the client
    unmount();
    render(<ExpectedView clientId={CLIENT} items={items} fys={fys} currentFyId="fy27" perms={{ canAct: false, canWaive: false, canUndo: false }} />);
    expect(screen.queryByRole("link", { name: /^Upload/ })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("uploadHref (AC-8)", () => {
  it("carries IDs only, and returns to the Expected tab", () => {
    const href = uploadHref(CLIENT, item({ registration: "33AAAPA0001A1Z1", registrationId: "r1" }));
    const u = new URL(href, "http://x");
    expect(u.pathname).toBe("/documents/new");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client: CLIENT, type: "t1", period: "p9", registration: "r1", from: `/clients/${CLIENT}?tab=expected` });
    expect(href).not.toContain("33AAAPA"); // never the GSTIN itself
    expect(new URL(uploadHref(CLIENT, item({})), "http://x").searchParams.has("registration")).toBe(false);
  });

  it("labels show the GSTIN only when the item carries one (client has several)", () => {
    expect(itemLabel(item({}))).toBe("Sales invoices / sales register · Sep 2026");
    expect(itemLabel(item({ registration: "33AAAPA0001A1Z1" }))).toBe("Sales invoices / sales register · Sep 2026 · 33AAAPA0001A1Z1");
  });
});

describe("ExpectedView — earlier FYs (review Important 2)", () => {
  it("lists still-pending earlier-FY items only under the current FY, and not in Received / Not needed", async () => {
    const user = userEvent.setup();
    render(<ExpectedView clientId={CLIENT} items={items} fys={fys} currentFyId="fy27" perms={all} />);
    await user.selectOptions(screen.getByLabelText("Status"), "Received");
    expect(screen.queryByText(/Mar 2026/)).toBeNull();
    await user.selectOptions(screen.getByLabelText("Status"), "Open");
    await user.selectOptions(screen.getByLabelText("Financial year"), "FY 2025-26");
    expect(screen.getByText("Bank statement · Mar 2026")).toBeInTheDocument(); // its own FY: no FY suffix
  });
});

