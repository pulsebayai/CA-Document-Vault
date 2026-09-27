import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Feature 02 step 11 — every new screen has a loading (skeleton) and an error (banner + retry) state that
// matches the screen, is announced to screen readers, and has no serious/critical axe violations.
afterEach(cleanup);

const loadings: [string, string, () => Promise<{ default: ComponentType }>][] = [
  ["/clients", "Loading clients…", () => import("@/app/(app)/clients/loading")],
  ["/clients/new", "Loading the form…", () => import("@/app/(app)/clients/new/loading")],
  ["/clients/import", "Loading the import page…", () => import("@/app/(app)/clients/import/loading")],
  ["/clients/[id]", "Loading the client…", () => import("@/app/(app)/clients/[id]/loading")],
  ["/clients/[id]/edit", "Loading the client…", () => import("@/app/(app)/clients/[id]/edit/loading")],
  ["/settings/catalogue", "Loading the catalogue…", () => import("@/app/(app)/settings/catalogue/loading")],
];

type ErrorPage = ComponentType<{ error: Error; retry: () => void }>;
const errors: [string, string, () => Promise<{ default: ErrorPage }>][] = [
  ["/clients", "Clients could not be loaded.", () => import("@/app/(app)/clients/error")],
  ["/clients/new", "The Add client form could not be loaded.", () => import("@/app/(app)/clients/new/error")],
  ["/clients/[id] (+ edit)", "This client could not be loaded.", () => import("@/app/(app)/clients/[id]/error")],
  ["/settings/catalogue", "The catalogue could not be loaded.", () => import("@/app/(app)/settings/catalogue/error")],
];

async function seriousAxe(container: HTMLElement) {
  const r = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, rules: { "color-contrast": { enabled: false } } });
  return r.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

describe("loading states", () => {
  it.each(loadings)("%s: announced as a busy status with its own label; blocks hidden from screen readers", async (_route, label, load) => {
    const { default: Loading } = await load();
    const { container } = render(<Loading />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent(label);
    expect(container.querySelector("[aria-label]")).toBeNull(); // no aria-label on generic divs (ARIA 1.2)
    expect(await seriousAxe(container)).toEqual([]);
  });
});

describe("error states", () => {
  it.each(errors)("%s: alert with a plain message (no error details) and a working Try again", async (_route, message, load) => {
    const { default: ErrorPage } = await load();
    const retry = vi.fn();
    const { container } = render(<ErrorPage error={new Error("secret DB detail ZZZPZ0001Z")} retry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(container.textContent).not.toMatch(/secret|ZZZPZ/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(await seriousAxe(container)).toEqual([]);
  });
});
