import { describe, expect, it } from "vitest";
import { paperReference, validateReceipt } from "@/lib/receipt/validation";

// Feature 13 (spec AC-13 … AC-15) — Log receipt fields. The database checks the same rules (tests/rls/log-receipt.test.ts).

const C = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const TODAY = "2026-10-31";
const ok = { clientId: C, count: "3", handedOverName: "Client's accountant" };

describe("validateReceipt", () => {
  it("defaults: hand delivery, today, not returnable, no type or period", () => {
    expect(validateReceipt(ok, TODAY)).toEqual({ errors: [], data: { clientId: C, docTypeId: null, periodId: null, count: 3,
      handedOverName: "Client's accountant", returnable: false, receivedOn: TODAY, channel: "hand_delivery", remark: null } });
  });

  it("keeps the type, its period and the other fields", () => {
    expect(validateReceipt({ ...ok, docTypeId: T, periodId: P, returnable: true, receivedOn: "2026-10-30", channel: "courier", remark: " passbooks " }, TODAY).data)
      .toMatchObject({ docTypeId: T, periodId: P, returnable: true, receivedOn: "2026-10-30", channel: "courier", remark: "passbooks" });
  });

  it("a period without a type is dropped", () => {
    expect(validateReceipt({ ...ok, periodId: P }, TODAY).data?.periodId).toBeNull();
  });

  it("refuses a missing client, a count outside 1–20, a missing or long name, a future date, an unknown channel", () => {
    const fields = (x: Record<string, unknown>) => validateReceipt(x, TODAY).errors.map((e) => e.field);
    expect(fields({ ...ok, clientId: "" })).toEqual(["clientId"]);
    for (const count of ["0", "21", "", "2.5", "x"]) expect(fields({ ...ok, count })).toEqual(["count"]);
    expect(fields({ ...ok, count: 20 })).toEqual([]);
    expect(fields({ ...ok, handedOverName: "  " })).toEqual(["handedOverName"]);
    expect(fields({ ...ok, handedOverName: "x".repeat(121) })).toEqual(["handedOverName"]);
    expect(fields({ ...ok, receivedOn: "2026-11-01" })).toEqual(["receivedOn"]);
    expect(fields({ ...ok, channel: "upload_link" })).toEqual(["channel"]);
  });

  it("the paper reference is client code + DOC-ID (Sankar #6)", () => {
    expect(paperReference("C0042", "DOC-FY26-27-00123")).toBe("C0042 · DOC-FY26-27-00123");
  });
});
