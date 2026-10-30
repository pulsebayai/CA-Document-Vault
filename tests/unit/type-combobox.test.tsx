import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeCombobox, type ComboType } from "@/components/type-combobox";

// Feature 12, spec AC-1 … AC-6 (D4): the type-ahead Document type field. Matching itself is tested in
// type-match.test.ts; this file covers the ARIA combobox, keyboard, the "N more" line and the propose row.

const ty = (id: string, name: string, groupName: string, groupSort: number, inPlan: boolean, extra: Partial<ComboType> = {}): ComboType => ({
  id, name, groupId: `g-${groupName}`, groupName, groupSort, frequency: "monthly", inPlan, proposed: false, aliases: [], ...extra,
});
const TYPES: ComboType[] = [
  ty("3b", "GSTR-3B", "GST", 1, true),
  ty("r1", "GSTR-1", "GST", 1, true, { frequency: "quarterly" }),
  ty("bank", "Bank statement", "Banking", 4, true),
  ty("f16", "Form 16", "TDS / TCS", 2, false, { aliases: ["Form 130"] }),
  ty("prop", "Bank advice", "Banking", 4, true, { proposed: true }),
];

function setup(props: Partial<React.ComponentProps<typeof TypeCombobox>> = {}) {
  const onChange = vi.fn();
  const onPropose = vi.fn();
  const utils = render(
    <form onSubmit={(e) => { e.preventDefault(); throw new Error("form submitted"); }}>
      <label htmlFor="t">Document type</label>
      <TypeCombobox id="t" types={TYPES} value="" onChange={onChange} canPropose onPropose={onPropose} {...props} />
    </form>,
  );
  return { ...utils, onChange, onPropose, input: screen.getByRole("combobox", { name: "Document type" }) };
}

afterEach(cleanup);

describe("ARIA combobox (AC-4)", () => {
  it("is a combobox that opens a listbox on focus, with group headings and frequencies (AC-1)", async () => {
    const { input } = setup();
    expect(input).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label") ?? g.textContent?.split("\n")[0]))
      .toHaveLength(2);
    expect(within(list).getByRole("group", { name: "GST" })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /GSTR-1.*Quarterly/ })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /Bank advice.*Proposed/ })).toBeInTheDocument();
  });

  it("↓/↑ move the active option (aria-activedescendant); Enter picks without submitting the form", async () => {
    const { input, onChange } = setup();
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}");
    const first = screen.getAllByRole("option")[0];
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledWith("r1");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("Esc closes and restores the last pick's name", async () => {
    const { input, onChange } = setup({ value: "bank" });
    expect(input).toHaveValue("Bank statement");
    await userEvent.clear(input);
    await userEvent.type(input, "gstr");
    await userEvent.keyboard("{Escape}");
    expect(input).toHaveValue("Bank statement");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking an option picks it", async () => {
    const { input, onChange } = setup();
    await userEvent.type(input, "130");
    await userEvent.click(screen.getByRole("option", { name: /Form 16/ }));
    expect(onChange).toHaveBeenCalledWith("f16");
  });

  it("has no axe violations while open", async () => {
    const { input, container } = setup();
    await userEvent.click(input);
    const r = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("typing (AC-2, AC-3)", () => {
  it("other types appear under 'Not in existing category plan' with their group name", async () => {
    const { input } = setup();
    await userEvent.type(input, "form");
    const other = screen.getByRole("group", { name: "Not in existing category plan" });
    expect(within(other).getByRole("option", { name: /Form 16.*TDS \/ TCS/ })).toBeInTheDocument();
  });

  it("says how many more match when over 8", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ty(`x${i}`, `Invoice ${i}`, "GST", 1, true));
    const { input } = setup({ types: many });
    await userEvent.type(input, "invoice");
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getByText("3 more — keep typing to narrow")).toBeInTheDocument();
  });

  it("with no plan types, the empty field says 'Type to search all types'", async () => {
    const { input } = setup({ types: TYPES.map((t) => ({ ...t, inPlan: false })) });
    await userEvent.click(input);
    expect(screen.getByText("Type to search all types")).toBeInTheDocument();
  });
});

describe("no match (AC-5)", () => {
  it("offers close types, then '+ Propose a new type…' which hands over the typed text", async () => {
    const { input, onPropose } = setup();
    await userEvent.type(input, "Bank advise");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Bank advice"), expect.stringContaining("Bank statement"), expect.stringContaining("+ Propose a new type…"),
    ]);
    await userEvent.click(screen.getByRole("option", { name: /Propose a new type/ }));
    expect(onPropose).toHaveBeenCalledWith("Bank advise");
  });

  it("without propose rights it says 'No matching type' and offers no propose row", async () => {
    const { input } = setup({ canPropose: false });
    await userEvent.type(input, "zzz");
    expect(screen.getByText("No matching type")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Propose/ })).toBeNull();
  });
});

describe("locked (AC-7)", () => {
  it("a disabled field shows the type and can't be opened", async () => {
    const { input } = setup({ value: "3b", disabled: true });
    expect(input).toBeDisabled();
    expect(input).toHaveValue("GSTR-3B");
  });
});
