import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Feature 05 step 5 — the header bell (spec AC-13, S4): accessible name with the count, opening loads the newest 20
// and marks them read, Esc closes and returns focus, empty and error states. The action is mocked.

const openNotifications = vi.fn();
vi.mock("@/lib/notifications/actions", () => ({ openNotifications: (...a: unknown[]) => openNotifications(...a) }));
afterEach(() => { cleanup(); openNotifications.mockReset(); });

const { NotificationBell } = await import("@/components/notification-bell");

const list = {
  unread: 2,
  items: [
    { id: "n1", text: "Salary register was merged into Payroll register.", createdAt: "2026-10-02T06:10:00Z", unread: true },
    { id: "n2", text: "Gate passes (Other) was approved.", createdAt: "2026-10-01T06:10:00Z", unread: false },
  ],
};

describe("NotificationBell (AC-13)", () => {
  it("names the count, opens the newest notifications and marks them read (S4)", async () => {
    openNotifications.mockResolvedValue({ ok: true, list });
    render(<NotificationBell unread={2} />);
    const bell = screen.getByRole("button", { name: "Notifications, 2 unread" });
    expect(bell).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(bell);
    const panel = await screen.findByRole("region", { name: "Notifications" });
    expect(await screen.findByText("Salary register was merged into Payroll register.")).toBeInTheDocument();
    expect(panel).toHaveTextContent("New: Salary register was merged");
    expect(panel).toHaveTextContent("2 Oct, 11:40"); // IST
    expect(openNotifications).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toHaveAttribute("aria-expanded", "true"));
  });

  it("Esc closes the panel and returns focus to the bell", async () => {
    openNotifications.mockResolvedValue({ ok: true, list: { unread: 0, items: [] } });
    render(<NotificationBell unread={0} />);
    const bell = screen.getByRole("button", { name: "Notifications" });
    fireEvent.click(bell);
    expect(await screen.findByText("No notifications")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    expect(bell).toHaveFocus();
  });

  it("a failed load shows the error with Try again", async () => {
    openNotifications.mockResolvedValueOnce({ ok: false, error: "Couldn't load notifications. Please try again." })
      .mockResolvedValueOnce({ ok: true, list });
    render(<NotificationBell unread={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications, 2 unread" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load notifications.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Gate passes (Other) was approved.")).toBeInTheDocument();
  });
});
