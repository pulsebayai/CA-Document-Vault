import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changedFields, officeSchema } from "@/lib/office/schema";
import { OfficeForm } from "@/app/(app)/settings/office/office-form";

// Feature 17 (spec AC-9): Settings › Office — validation, changed-field names for the activity row, and the form.
describe("officeSchema", () => {
  it("trims and collapses spaces; an empty branch is null", () => {
    expect(officeSchema.parse({ name: "  Kushal   Associates ", branch: "  " })).toEqual({ name: "Kushal Associates", branch: null });
    expect(officeSchema.parse({ name: "K", branch: " Pondicherry " })).toEqual({ name: "K", branch: "Pondicherry" });
  });

  it("requires a name; both fields ≤ 120 characters", () => {
    const issues = (v: { name: string; branch: string }) => {
      const r = officeSchema.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`);
    };
    expect(issues({ name: "  ", branch: "" })).toEqual(["name: Enter the firm's name."]);
    expect(issues({ name: "x".repeat(121), branch: "" })).toEqual(["name: Firm name can be at most 120 characters."]);
    expect(issues({ name: "ok", branch: "y".repeat(121) })).toEqual(["branch: Branch can be at most 120 characters."]);
  });

  it("changedFields lists names only, for the activity row", () => {
    expect(changedFields({ name: "A", branch: null }, { name: "A", branch: null })).toEqual([]);
    expect(changedFields({ name: "A", branch: null }, { name: "B", branch: "X" })).toEqual(["name", "branch"]);
    expect(changedFields({ name: "A", branch: "X" }, { name: "A", branch: null })).toEqual(["branch"]);
  });
});

describe("OfficeForm", () => {
  afterEach(cleanup);
  it("shows the current values and announces the result", async () => {
    const action = vi.fn(async () => ({ ok: true as const, message: "Saved." }));
    render(<OfficeForm name="Kushal Associates" branch="Pondicherry" action={action} />);
    expect(screen.getByLabelText("Firm name")).toHaveValue("Kushal Associates");
    expect(screen.getByLabelText(/Branch/)).toHaveValue("Pondicherry");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("marks a field invalid with its message", async () => {
    const action = vi.fn(async () => ({ ok: false as const, error: "Check the highlighted fields.", fieldErrors: { name: "Enter the firm's name." } }));
    render(<OfficeForm name="" branch={null} action={action} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the highlighted fields.");
    expect(screen.getByLabelText("Firm name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Firm name")).toHaveAccessibleDescription("Enter the firm's name.");
  });
});
