import { describe, expect, it } from "vitest";
import {
  DSC_CLASSES, DSC_ISSUERS, validateArchiveReason, validateCustody, validateDsc, validatePassword, validateRemindDays,
} from "@/lib/validation/dsc";

// Feature 14 spec AC-2, AC-4, AC-5, AC-8, AC-10 — the fields staff fill in. Pure, so unit-tested; the database
// checks the same limits again (tests/rls/dsc.test.ts). Contract (plan step 4):
//   validateDsc(input, { create }) → { data, errors[{ field, message }] }; on create the password is required.
//   validatePassword(value, confirm?) — "Change password" types it twice.
//   validateCustody(input, today) · validateRemindDays(value) · validateArchiveReason(value).

const C = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-10-31";
const ok = { clientId: C, holderName: "  Ravi Kumar ", expiresOn: "2027-03-12", password: "pin-1234" };
const fields = (r: { errors: Array<{ field: string }> }) => r.errors.map((e) => e.field);

describe("validateDsc (AC-2, AC-4)", () => {
  it("trims, keeps the optional fields and drops empty ones", () => {
    expect(validateDsc(ok, { create: true })).toEqual({ errors: [], data: {
      clientId: C, holderName: "Ravi Kumar", expiresOn: "2027-03-12", password: "pin-1234",
      dscClass: null, issuer: null, tokenNote: null,
    } });
    expect(validateDsc({ ...ok, dscClass: "dgft", issuer: " Capricorn ", tokenNote: " Token 77 " }, { create: true }).data)
      .toMatchObject({ dscClass: "dgft", issuer: "Capricorn", tokenNote: "Token 77" });
  });

  it("the password is kept exactly as typed (no trimming: spaces may be part of a PIN)", () => {
    expect(validateDsc({ ...ok, password: " 12 34 " }, { create: true }).data?.password).toBe(" 12 34 ");
  });

  it("requires holder, a real expiry date and, on create, the password", () => {
    expect(fields(validateDsc({ ...ok, holderName: " " }, { create: true }))).toEqual(["holderName"]);
    expect(fields(validateDsc({ ...ok, holderName: "x".repeat(121) }, { create: true }))).toEqual(["holderName"]);
    for (const expiresOn of ["", "2027-02-30", "12/03/2027"]) expect(fields(validateDsc({ ...ok, expiresOn }, { create: true }))).toEqual(["expiresOn"]);
    expect(fields(validateDsc({ ...ok, password: "" }, { create: true }))).toEqual(["password"]);
    expect(fields(validateDsc({ ...ok, password: "x".repeat(101) }, { create: true }))).toEqual(["password"]);
  });

  it("an edit carries no password (it changes only through Change password)", () => {
    const r = validateDsc({ ...ok, password: undefined }, { create: false });
    expect(r.errors).toEqual([]);
    expect(r.data?.password).toBeNull();
    expect(validateDsc({ ...ok, password: "typed" }, { create: false }).data?.password).toBeNull();
  });

  it("an expired date is allowed (a DSC entered after it lapsed is still tracked)", () => {
    expect(validateDsc({ ...ok, expiresOn: "2025-01-01" }, { create: true }).errors).toEqual([]);
  });

  it("refuses an unknown class and long issuer or notes; offers the spec's class and issuer lists", () => {
    expect(DSC_CLASSES.map((c) => c.label)).toEqual(["Class 3", "DGFT", "Other"]);
    expect(DSC_ISSUERS).toEqual(["eMudhra", "Capricorn", "Pantasign", "VSign", "IDSign", "Other"]);
    expect(fields(validateDsc({ ...ok, dscClass: "class2" }, { create: true }))).toEqual(["dscClass"]);
    expect(fields(validateDsc({ ...ok, issuer: "x".repeat(81) }, { create: true }))).toEqual(["issuer"]);
    expect(fields(validateDsc({ ...ok, tokenNote: "x".repeat(201) }, { create: true }))).toEqual(["tokenNote"]);
  });
});

describe("validatePassword (AC-4 Change password)", () => {
  it("needs 1–100 characters typed the same twice", () => {
    expect(validatePassword("abc", "abc")).toEqual({ value: "abc", error: null });
    expect(validatePassword("abc", "abd").error).toMatch(/don't match/i);
    expect(validatePassword("", "").error).toMatch(/enter/i);
    expect(validatePassword("x".repeat(101), "x".repeat(101)).error).toMatch(/100/);
  });
});

describe("validateCustody (AC-8)", () => {
  it("needs a name (1–120) and a date not in the future; the note is optional (≤ 200)", () => {
    expect(validateCustody({ personName: " Ravi ", onDate: TODAY, note: "" }, TODAY)).toEqual({ errors: [], data: { personName: "Ravi", onDate: TODAY, note: null } });
    expect(fields(validateCustody({ personName: "", onDate: TODAY }, TODAY))).toEqual(["personName"]);
    expect(fields(validateCustody({ personName: "R", onDate: "2026-11-01" }, TODAY))).toEqual(["onDate"]);
    expect(fields(validateCustody({ personName: "R", onDate: TODAY, note: "x".repeat(201) }, TODAY))).toEqual(["note"]);
  });

  it("the date defaults to today", () => {
    expect(validateCustody({ personName: "Ravi" }, TODAY).data?.onDate).toBe(TODAY);
  });
});

describe("validateRemindDays (AC-10) and validateArchiveReason (AC-5)", () => {
  it("remind days are a whole number 1–180", () => {
    expect(validateRemindDays("30")).toEqual({ value: 30, error: null });
    expect(validateRemindDays(180).value).toBe(180);
    for (const v of ["0", "181", "", "7.5", "x"]) expect(validateRemindDays(v).error).not.toBeNull();
  });

  it("an archive reason is required, ≤ 500", () => {
    expect(validateArchiveReason(" Client closed ")).toEqual({ value: "Client closed", error: null });
    expect(validateArchiveReason("  ").error).not.toBeNull();
    expect(validateArchiveReason("x".repeat(501)).error).not.toBeNull();
  });
});
