import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayData } from "@/lib/today/queries";

// Feature 06 step 5 — Today (AC-2…AC-5): counts as pressed-state filter buttons, the scope toggle, cards, empty states.
// Counts = rows and the scope rules are proven against the database in tests/rls/today.test.ts.

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
afterEach(() => { cleanup(); push.mockClear(); });
const { TodayView } = await import("@/app/(app)/today/today-view");

const data = (over: Partial<TodayData> = {}): TodayData => ({
  today: "2026-09-16", counts: { overdue: 3, dueWeek: 7 }, hasMore: false,
  cards: [{
    clientId: "c1", name: "Sankar Software Pvt Ltd", initials: "SS", people: "Incharge Ravi · GST Priya", badge: "1 overdue", badgeTone: "late",
    rows: [{ id: "e1", kind: "overdue", title: "GST · Invoices · Aug 2026", label: "Overdue", labelTone: "late",
      detail: "Not received · 13 days late · reminded twice", reminders: true, overdueFrom: "2026-09-03", uploadHref: "/documents/new?client=c1" }],
  }],
  ...over,
});

describe("TodayView", () => {
  it("shows the date, the counts and a card per client with its rows and actions", () => {
    render(<TodayView data={data()} inbox={4} scope="mine" show={null} page={0} />);
    expect(screen.getByRole("heading", { name: "Today" })).toBeVisible();
    expect(screen.getByText("Wednesday, 16 September 2026 · 1 client needs something")).toBeVisible();
    expect(screen.getByRole("button", { name: "3 Overdue" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "7 Due this week" })).toBeVisible();
    expect(screen.getByRole("link", { name: "4 In inbox" })).toHaveAttribute("href", "/inbox");
    const card = within(screen.getByRole("list", { name: "Clients that need something" })).getAllByRole("listitem")[0];
    expect(within(card).getByRole("link", { name: "Sankar Software Pvt Ltd" })).toHaveAttribute("href", "/clients/c1");
    expect(card).toHaveTextContent("Incharge Ravi · GST Priya");
    expect(card).toHaveTextContent("1 overdue");
    const rows = screen.getByRole("list", { name: "Open documents for Sankar Software Pvt Ltd" });
    expect(rows).toHaveTextContent("Not received · 13 days late · reminded twice");
    expect(rows).toHaveTextContent("Overdue");
    expect(within(rows).getByRole("button", { name: "Remind Sankar Software Pvt Ltd" })).toBeVisible();
    expect(within(rows).getByRole("button", { name: "Log call with Sankar Software Pvt Ltd" })).toBeVisible();
    expect(within(rows).getByRole("link", { name: "Upload GST · Invoices · Aug 2026" })).toHaveAttribute("href", "/documents/new?client=c1");
  });

  it("a count filters (enum in the URL) and clicking it again clears it; the scope toggle keeps the filter", async () => {
    const { rerender } = render(<TodayView data={data()} inbox={0} scope="mine" show={null} page={0} />);
    await userEvent.click(screen.getByRole("button", { name: "3 Overdue" }));
    expect(push).toHaveBeenLastCalledWith("/today?show=overdue");
    rerender(<TodayView data={data()} inbox={0} scope="mine" show="overdue" page={0} />);
    expect(screen.getByRole("button", { name: "3 Overdue" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "3 Overdue" }));
    expect(push).toHaveBeenLastCalledWith("/today");
    await userEvent.click(screen.getByRole("button", { name: "Everyone" }));
    expect(push).toHaveBeenLastCalledWith("/today?scope=everyone&show=overdue");
    expect(screen.getByRole("button", { name: "My clients" })).toHaveAttribute("aria-pressed", "true");
  });

  it("empty states: Mine, Everyone, and a filter with nothing in it", () => {
    render(<TodayView data={data({ cards: [], counts: { overdue: 0, dueWeek: 0 } })} inbox={0} scope="mine" show={null} page={0} />);
    expect(screen.getByText("Nothing needs you today")).toBeVisible();
    cleanup();
    render(<TodayView data={data({ cards: [], counts: { overdue: 0, dueWeek: 0 } })} inbox={0} scope="everyone" show={null} page={0} />);
    expect(screen.getByText("Nothing outstanding")).toBeVisible();
    cleanup();
    render(<TodayView data={data({ cards: [] })} inbox={0} scope="mine" show="due_week" page={0} />);
    expect(screen.getByText("Nothing in this list")).toBeVisible();
  });

  it("Show more links to the next page", () => {
    render(<TodayView data={data({ hasMore: true })} inbox={0} scope="everyone" show={null} page={0} />);
    expect(screen.getByRole("link", { name: "Show more" })).toHaveAttribute("href", "/today?scope=everyone&page=1");
    expect(screen.getByText(/1\+ clients need something/)).toBeVisible();
  });
});
