import { describe, expect, it } from "vitest";
import { expectedTabPath, prefillFrom } from "@/lib/expected/prefill";
import type { ClientTypes, PeriodOption, TypeOption } from "@/lib/documents/queries";

// Feature 04 step 5 — Upload from an expected row pre-fills Add document (spec AC-8). Only values valid for the
// client survive; anything else falls back to the form's normal defaults (03 AC-3).

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const type = (over: Partial<TypeOption>): TypeOption => ({
  id: id(1), name: "Sales invoices / sales register", groupId: id(90), groupName: "GST", periodKind: "month",
  frequency: "monthly", registrationKind: "gstin", proposed: false, ...over,
});
const sales = type({});
const form16 = type({ id: id(2), name: "Form 16 from employer", groupName: "Income Tax", periodKind: "year", frequency: "yearly", registrationKind: null });
const bank = type({ id: id(3), name: "Bank statement", groupName: "Banking", registrationKind: null });
const types: ClientTypes = {
  planTypes: [sales, form16],
  otherTypes: [bank],
  registrations: [{ id: id(20), kind: "gstin", number: "33AAAPA0001A1Z1" }, { id: id(21), kind: "gstin", number: "29AAAPA0001A1Z2" }, { id: id(22), kind: "tan", number: "CHEA00001A" }],
};
const periods: PeriodOption[] = [
  { id: id(30), kind: "month", code: "2026-09", label: "Sep 2026", fyCode: "2026-27" },
  { id: id(31), kind: "year", code: "2025-26", label: "FY 2025-26", fyCode: "2025-26" },
  { id: id(32), kind: "quarter", code: "2026-27-Q2", label: "Q2 2026-27", fyCode: "2026-27" },
];

describe("prefillFrom (AC-8)", () => {
  it("keeps a valid type, period and registration", () => {
    expect(prefillFrom({ type: sales.id, period: id(30), registration: id(21) }, types, periods))
      .toEqual({ docTypeId: sales.id, periodId: id(30), registrationId: id(21) });
    expect(prefillFrom({ type: form16.id, period: id(31) }, types, periods)).toEqual({ docTypeId: form16.id, periodId: id(31), registrationId: "" });
    expect(prefillFrom({ type: bank.id, period: id(30) }, types, periods)?.docTypeId).toBe(bank.id); // "Other" types too
  });

  it("drops a type the client can't file, and anything that isn't a UUID", () => {
    expect(prefillFrom({ type: id(99), period: id(30) }, types, periods)).toBeNull();
    expect(prefillFrom({ type: "Sales invoices", period: id(30) }, types, periods)).toBeNull();
    expect(prefillFrom({ type: [sales.id, sales.id] }, types, periods)).toBeNull();
    expect(prefillFrom({}, types, periods)).toBeNull();
  });

  it("drops a period that doesn't exist or whose kind the type doesn't allow", () => {
    expect(prefillFrom({ type: form16.id, period: id(30) }, types, periods)?.periodId).toBe(""); // month for a yearly type
    expect(prefillFrom({ type: sales.id, period: id(99) }, types, periods)?.periodId).toBe("");
  });

  it("drops a registration of another kind or client; picks the only one of the kind by default", () => {
    expect(prefillFrom({ type: sales.id, period: id(30), registration: id(22) }, types, periods)?.registrationId).toBe(""); // TAN for a GSTIN type
    expect(prefillFrom({ type: sales.id, period: id(30), registration: id(99) }, types, periods)?.registrationId).toBe("");
    const oneGstin = { ...types, registrations: [types.registrations[0]] };
    expect(prefillFrom({ type: sales.id, period: id(30) }, oneGstin, periods)?.registrationId).toBe(id(20));
    expect(prefillFrom({ type: bank.id, period: id(30), registration: id(20) }, types, periods)?.registrationId).toBe(""); // type has no kind
  });

  it("returns to the Expected tab", () => {
    expect(expectedTabPath(id(5))).toBe(`/clients/${id(5)}?tab=expected`);
  });
});
