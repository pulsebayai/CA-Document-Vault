import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedRow } from "@/lib/activity-feed/queries";

// Feature 08 AC-5, AC-7 … AC-9 — the Activity screen's view and its URL filters. What each role may read is
// enforced by activity_select (tests/rls/activity-visibility.test.ts); the feed itself in activity-feed.test.ts.

const loadEarlier = vi.fn();
vi.mock("@/lib/activity-feed/actions", () => ({ loadEarlier }));
vi.mock("@/lib/search/actions", () => ({ findClients: vi.fn(async () => ({ ok: true, clients: [] })) }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { ActivityView, activityChips, groupByDay, rowHref } = await import("@/app/(app)/activity/activity-view");
const { NO_FILTERS, activityQuery, feedArgs, parseActivityParams } = await import("@/lib/activity-feed/filters");

const C = "00000000-0000-4000-8000-0000000000c1";
const D = "00000000-0000-4000-8000-0000000000d1";
const S = "00000000-0000-4000-8000-0000000000a1";
const row = (over: Partial<FeedRow>): FeedRow => ({
  id: 1, at: "2026-10-02T05:30:00Z", action: "document.reviewed", entity_type: "document", entity_id: D, data: {},
  actor_id: S, actor_name: "Ravi Kumar", client_id: C, client_name: "Rajesh Traders", document_id: D, doc_code: "DOC-FY26-27-00111",
  doc_type_name: "Form 16", doc_group_name: "Income Tax", ...over,
});
const options = { staff: [{ id: S, name: "Ravi Kumar" }], client: null, document: null };
const NOW = "2026-10-02T06:00:00Z";

describe("URL filters (AC-7)", () => {
  it("keeps IDs, a known category and dates; drops anything else", () => {
    expect(parseActivityParams({ staff: S, client: "nope", action: "sign_ins", from: "2026-10-01", to: "1 Oct", q: "Rajesh" }))
      .toEqual({ ...NO_FILTERS, staff: S, action: "sign_ins", from: "2026-10-01" });
    expect(parseActivityParams({ action: "everything" }).action).toBeNull();
  });

  it("round-trips through the query string and builds the feed argument (sign-ins only by category)", () => {
    const f = { ...NO_FILTERS, client: C, action: "sign_ins" as const, to: "2026-10-02" };
    expect(parseActivityParams(Object.fromEntries(new URLSearchParams(activityQuery(f))))).toEqual(f);
    expect(feedArgs(f, { at: NOW, id: 9 })).toEqual({ client_id: C, actions: ["auth.signed_in"], to: "2026-10-02", before: { at: NOW, id: 9 } });
    expect(feedArgs(NO_FILTERS)).toEqual({});
  });

  it("chips name the filter and its value", () => {
    expect(activityChips({ ...NO_FILTERS, staff: S, action: "review_dispatch", from: "2026-09-28" }, options).map((c) => c.label))
      .toEqual(["Staff: Ravi Kumar", "Action: Review & dispatch", "From: 28 Sept 2026"]);
  });
});

describe("rows (AC-5, AC-9)", () => {
  it("group by IST day", () => {
    const g = groupByDay([row({ id: 3, at: "2026-10-01T18:45:00Z" }), row({ id: 2, at: "2026-10-01T18:29:00Z" }), row({ id: 1, at: "2026-10-01T05:00:00Z" })]);
    expect(g.map((x) => [x.day, x.rows.map((r) => r.id)])).toEqual([["2026-10-02", [3]], ["2026-10-01", [2, 1]]]);
  });

  it("link to the document, else the client, else the settings page the row is about", () => {
    expect(rowHref(row({}), false)).toBe(`/documents/${D}`);
    expect(rowHref(row({ document_id: null }), false)).toBe(`/clients/${C}`);
    expect(rowHref(row({ document_id: null, client_id: null, action: "doc_type.proposed" }), false)).toBe("/settings/catalogue");
    expect(rowHref(row({ document_id: null, client_id: null, action: "staff.invited" }), false)).toBeNull();
    expect(rowHref(row({ document_id: null, client_id: null, action: "staff.invited" }), true)).toBe("/settings/users");
    expect(rowHref(row({ document_id: null, client_id: null, action: "auth.signed_in" }), true)).toBeNull();
  });
});

describe("ActivityView (AC-5)", () => {
  it("shows day headings, time, sentence and detail; the sentence links; Load earlier appends the next page", async () => {
    const user = userEvent.setup();
    loadEarlier.mockResolvedValue({ ok: true, page: { rows: [row({ id: 0, at: "2026-09-28T06:00:00Z", action: "dispatch.created", data: { document_ids: [D, C] } })], next: null } });
    render(<ActivityView filters={NO_FILTERS} options={options} limited={false} isAdmin={false} now={NOW}
      initial={{ ok: true, page: { rows: [row({ id: 2 }), row({ id: 1, at: "2026-10-01T10:00:00Z", action: "document.added" })], next: { at: "2026-10-01T10:00:00Z", id: 1 } } }} />);
    expect(screen.getByText("Everything anyone did, newest first")).toBeInTheDocument();
    const today = screen.getByRole("region", { name: "Today, 2 October" });
    expect(within(today).getByRole("link", { name: "Ravi reviewed Form 16" })).toHaveAttribute("href", `/documents/${D}`);
    expect(within(today).getByText("11:00")).toBeInTheDocument();
    expect(within(today).getByText("Rajesh Traders · Income Tax · DOC-FY26-27-00111")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Yesterday, 1 October" })).toHaveTextContent("Ravi added Form 16");

    await user.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(loadEarlier).toHaveBeenCalledWith("", { at: "2026-10-01T10:00:00Z", id: 1 });
    expect(await screen.findByRole("region", { name: "Monday, 28 September" })).toHaveTextContent("Ravi dispatched 2 originals");
    expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument();
  });

  it("Limited's subtitle; empty and error states", () => {
    const { unmount } = render(<ActivityView filters={NO_FILTERS} options={options} limited isAdmin={false} now={NOW} initial={{ ok: true, page: { rows: [], next: null } }} />);
    expect(screen.getByText("Your actions and your clients, newest first")).toBeInTheDocument();
    expect(screen.getByText("No activity yet.")).toBeInTheDocument();
    unmount();
    render(<ActivityView filters={NO_FILTERS} options={options} limited={false} isAdmin={false} now={NOW} initial={{ ok: false, error: "Activity could not be loaded. Please try again." }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Activity could not be loaded.");
  });

  it("filters change the URL (IDs and enums only); a chip removes its filter", async () => {
    const user = userEvent.setup();
    render(<ActivityView filters={{ ...NO_FILTERS, action: "documents" }} options={options} limited={false} isAdmin={false} now={NOW}
      initial={{ ok: true, page: { rows: [], next: null } }} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Staff" }), S);
    expect(push).toHaveBeenLastCalledWith(`/activity?staff=${S}&action=documents`, { scroll: false });
    await user.click(screen.getByRole("button", { name: "Remove filter Action: Documents" }));
    expect(push).toHaveBeenLastCalledWith("/activity", { scroll: false });
  });
});
