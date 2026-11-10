import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkOptions, LinkTypeOption } from "@/lib/upload-links/queries";

// R1 staging finding F4 (owner 2026-11-10): "Other documents to request" in the Remind dialog uses 12's type-ahead
// Document type field (typing, aliases, the client's plan types first), not the old dropdown.

vi.mock("@/lib/upload-links/actions", () => ({ linkOptions: vi.fn() }));
afterEach(cleanup);
const { AdHocEditor, newRow } = await import("@/app/(app)/clients/link-section");
type Row = ReturnType<typeof newRow>;

const t = (over: Partial<LinkTypeOption> & Pick<LinkTypeOption, "id" | "name">): LinkTypeOption => ({
  group: "Income Tax", groupId: "g-it", groupSort: 3, periodKind: "none", registrationKind: null, proposed: false,
  frequency: "as_needed", aliases: [], inPlan: false, ...over,
});
const options: LinkOptions = {
  enabled: true, base: "https://vault.example.in", periods: [], registrations: [],
  types: [
    t({ id: "t-16", name: "Form 16", aliases: ["Form 130"] }),
    t({ id: "t-bank", name: "Bank statement", group: "Banking", groupId: "g-bank", groupSort: 4, frequency: "monthly", inPlan: true }),
    t({ id: "t-notice", name: "GST notice / order received", group: "GST", groupId: "g-gst", groupSort: 1 }),
  ],
};

function Harness({ onRows }: { onRows: (r: Row[]) => void }) {
  const [rows, setRows] = useState<Row[]>([newRow()]);
  return <AdHocEditor rows={rows} setRows={(r) => { setRows(r); onRows(r); }} options={options} today="2026-11-10" disabled={false} />;
}

describe("ad-hoc request type field (F4)", () => {
  it("is the type-ahead combobox, not a dropdown", () => {
    render(<Harness onRows={() => undefined} />);
    expect(screen.getByRole("combobox", { name: "Document type" })).toHaveAttribute("type", "text");
    expect(screen.queryByRole("option", { name: "Choose a type…" })).toBeNull();
  });

  it("matches an old/new form name and sets the chosen type on the row", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onRows={seen} />);
    await user.type(screen.getByRole("combobox", { name: "Document type" }), "Form 130");
    await user.click(within(screen.getByRole("listbox", { name: "Matching types" })).getByRole("option", { name: /^Form 16/ }));
    expect(seen).toHaveBeenLastCalledWith([expect.objectContaining({ docTypeId: "t-16" })]);
    expect(screen.getByRole("combobox", { name: "Document type" })).toHaveValue("Form 16");
  });

  it("lists the client's plan types first and offers no new type", async () => {
    const user = userEvent.setup();
    render(<Harness onRows={() => undefined} />);
    await user.click(screen.getByRole("combobox", { name: "Document type" }));
    const names = within(screen.getByRole("listbox", { name: "Matching types" })).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(names[0]).toMatch(/^Bank statement/);
    expect(names.join(" ")).not.toMatch(/Add .* as a new type|new type/i);
  });
});
