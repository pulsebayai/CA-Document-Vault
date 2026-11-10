import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientSearchResult } from "@/lib/clients/queries";

// R1 staging finding F1 (2026-11-10): "My clients" and "Has overdue" looked the same on and off — only a faint colour
// shift (WCAG 1.4.1: state must not rely on colour alone). When on, each shows a tick (hidden from screen readers,
// which already hear aria-pressed, so the accessible names stay "My clients" / "Has overdue") and a solid fill.

const search = vi.fn(async (input: Record<string, unknown>) => { void input; return { ok: true as const, rows: [], matched: 0, total: 3 }; });
vi.mock("@/lib/clients/actions", () => ({ searchClients: search }));
afterEach(() => { cleanup(); search.mockClear(); });
const { ClientsBrowser } = await import("@/app/(app)/clients/clients-browser");

const initial: ClientSearchResult = { rows: [], matched: 0, total: 3 };
const tick = (el: HTMLElement) => el.querySelector('[aria-hidden="true"][data-pressed-mark]');
// Re-check fix: two classes for one property (bg-panel + bg-bad) let Tailwind's CSS order pick white on white.
const oneEach = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.filter((x) => /^bg-/.test(x))).toHaveLength(1);
  expect(c.filter((x) => /^text-(?!\[)/.test(x))).toHaveLength(1);
};

describe("filter toggles show their state without relying on colour (F1)", () => {
  it("Has overdue: no tick when off, a tick when on, and the name stays the same", async () => {
    const user = userEvent.setup();
    render(<ClientsBrowser initial={initial} staff={[]} canAdd={false} />);
    const chip = screen.getByRole("button", { name: "Has overdue" });
    expect(tick(chip)).toBeNull();
    await user.click(chip);
    expect(screen.getByRole("button", { name: "Has overdue" })).toBe(chip);
    expect(tick(chip)).toHaveTextContent("✓");
    expect(chip.className).toMatch(/\bbg-bad\b/);
    expect(chip.className).toMatch(/\btext-white\b/);
    oneEach(chip);
    await user.click(chip);
    oneEach(chip);
  });

  it("My clients: on by default for Staff shows the tick and a solid fill; switching off removes both", async () => {
    const user = userEvent.setup();
    render(<ClientsBrowser initial={initial} staff={[]} canAdd={false} mine={{ on: true, defaultOn: true }} />);
    const chip = screen.getByRole("button", { name: "My clients" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(tick(chip)).toHaveTextContent("✓");
    expect(chip.className).toMatch(/\bbg-accent\b/);
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(tick(chip)).toBeNull();
    expect(chip.className).not.toMatch(/\bbg-accent\b/);
    oneEach(chip);
  });
});
