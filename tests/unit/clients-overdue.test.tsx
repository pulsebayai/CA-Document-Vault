import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientListItem } from "@/app/(app)/clients/clients-view";
import type { ClientSearchResult } from "@/lib/clients/queries";

// Feature 04 step 7 — Clients list (spec AC-15, mockup 03): "N overdue · N due today" on the right of each row
// (hidden when both are 0) and the "Has overdue" chip, sent to the server action like the other filters.

const search = vi.fn(async (input: Record<string, unknown>) => { void input; return { ok: true as const, rows: [], matched: 0, total: 3 }; });
vi.mock("@/lib/clients/actions", () => ({ searchClients: search }));
afterEach(() => { cleanup(); search.mockClear(); });
const { ClientsView, openText } = await import("@/app/(app)/clients/clients-view");
const { ClientsBrowser } = await import("@/app/(app)/clients/clients-browser");

const row = (over: Partial<ClientListItem>): ClientListItem => ({
  id: crypto.randomUUID(), code: "C0001", name: "Alpha Traders", clientType: "proprietorship", pan: null, inchargeName: "Asha",
  groups: ["GST"], pausedGroups: [], archived: false, ...over,
});

describe("openText (AC-15)", () => {
  it("shows only the parts that are not 0", () => {
    expect(openText(2, 1)).toBe("2 overdue · 1 due today");
    expect(openText(3, 0)).toBe("3 overdue");
    expect(openText(0, 1)).toBe("1 due today");
    expect(openText(0, 0)).toBe("");
  });
});

describe("ClientsView rows (AC-15)", () => {
  it("shows the overdue text on the right of the row, and nothing for a client with nothing open", () => {
    render(<ClientsView clients={[row({ overdue: 2, dueToday: 1 }), row({ name: "Quiet Co", code: "C0002", overdue: 0, dueToday: 0 })]} total={2} />);
    const items = within(screen.getByRole("list", { name: "Clients" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("2 overdue · 1 due today");
    expect(items[1]).not.toHaveTextContent(/overdue|due today/);
  });
});

describe("Has overdue chip (AC-15)", () => {
  it("is a toggle button; pressing it searches with hasOverdue and leaves the URL alone", async () => {
    const user = userEvent.setup();
    const initial: ClientSearchResult = { rows: [row({ overdue: 1 })], matched: 1, total: 3 };
    const before = window.location.href;
    render(<ClientsBrowser initial={initial} staff={[]} canAdd={false} />);
    const chip = screen.getByRole("button", { name: "Has overdue" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await vi.waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({ hasOverdue: true, page: 1 })));
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument(); // counts as a filter
    expect(window.location.href).toBe(before);
  });
});
