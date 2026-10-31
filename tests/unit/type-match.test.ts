import { describe, expect, it } from "vitest";
import { matchTypes, normaliseTypeText, type TypeOption } from "@/lib/types/match";

// Feature 12, spec AC-1 … AC-5: the type-ahead Document type field (Sankar's prototype). Written before the code
// (plan step 1). matchTypes is pure: the form passes the types 03 already loads (plan types + approved types).

const t = (id: string, name: string, groupName: string, groupSort: number, inPlan: boolean, extra: Partial<TypeOption> = {}): TypeOption => ({
  id, name, groupId: `g-${groupName}`, groupName, groupSort, frequency: "monthly", inPlan, proposed: false, aliases: [], ...extra,
});

const TYPES: TypeOption[] = [
  t("3b", "GSTR-3B", "GST", 1, true),
  t("r1", "GSTR-1", "GST", 1, true),
  t("inv", "Sales invoices", "GST", 1, true),
  t("bank", "Bank statement", "Banking", 4, true),
  t("26q", "Form 26Q working", "TDS / TCS", 2, false, { aliases: ["26Q"] }),
  t("f16", "Form 16", "TDS / TCS", 2, false, { aliases: ["Form 130"] }),
  t("26as", "Form 26AS", "Income Tax", 3, true, { frequency: "yearly" }),
  t("loan", "Loan statement", "Banking", 4, false),
  t("prop", "Bank advice", "Banking", 4, true, { proposed: true }),
];
const ids = (r: ReturnType<typeof matchTypes>) => r.sections.flatMap((s) => s.rows.map((x) => x.type.id));
const headings = (r: ReturnType<typeof matchTypes>) => r.sections.map((s) => s.heading);

describe("normaliseTypeText", () => {
  it("ignores case, spaces, hyphens, dots, slashes and underscores", () => {
    for (const s of ["GSTR-3B", "gstr 3b", "GSTR3B", "g.s.t.r/3_b"]) expect(normaliseTypeText(s)).toBe("gstr3b");
  });
});

describe("empty field (AC-1)", () => {
  it("shows only the client's plan types, grouped under group headings in catalogue order", () => {
    const r = matchTypes(TYPES, "");
    expect(headings(r)).toEqual(["GST", "Income Tax", "Banking"]);
    expect(ids(r)).toEqual(["r1", "3b", "inv", "26as", "prop", "bank"]); // by group order, then name
    expect(r.sections.every((s) => s.kind === "group")).toBe(true);
    expect(r.more).toBe(0);
    expect(r.searchAll).toBe(false);
  });

  it("with no plan types (no client yet) asks the user to type to search all types", () => {
    const r = matchTypes(TYPES.map((x) => ({ ...x, inPlan: false })), "");
    expect(r.sections).toEqual([]);
    expect(r.searchAll).toBe(true);
  });
});

describe("typing (AC-2, AC-3)", () => {
  it("matches the name, ignoring hyphens and spaces: '3b' finds GSTR-3B", () => {
    expect(ids(matchTypes(TYPES, "3b"))).toEqual(["3b"]);
    expect(ids(matchTypes(TYPES, "gstr 3b"))).toEqual(["3b"]);
  });

  it("matches aliases: '26q' finds Form 26Q working; 'form 130' finds Form 16", () => {
    expect(ids(matchTypes(TYPES, "26q"))).toEqual(["26q"]);
    expect(ids(matchTypes(TYPES, "form 130"))).toEqual(["f16"]);
  });

  it("matches the group name: 'banking' lists the group's plan types, then the others", () => {
    const r = matchTypes(TYPES, "banking");
    expect(headings(r)).toEqual(["Banking", "Not in existing category plan"]); // D4
    expect(r.sections[0].rows.map((x) => x.type.id)).toEqual(["prop", "bank"]);
    expect(r.sections[1].rows.map((x) => x.type.id)).toEqual(["loan"]);
    expect(r.sections[1].kind).toBe("other");
  });

  it("plan types come first under their group headings; other types follow under one 'Not in existing category plan' heading (D4)", () => {
    const r = matchTypes(TYPES, "form");
    expect(headings(r)).toEqual(["Income Tax", "Not in existing category plan"]); // D4
    expect(r.sections[0].rows.map((x) => x.type.id)).toEqual(["26as"]);
    expect(r.sections[1].rows.map((x) => x.type.id)).toEqual(["f16", "26q"]);
  });

  it("within a section, names that start with the text come before names that only contain it", () => {
    const r = matchTypes([t("a", "Statement of accounts", "Banking", 4, true), t("b", "Bank statement", "Banking", 4, true)], "statement");
    expect(ids(r)).toEqual(["a", "b"]);
  });

  it("shows at most 8 rows and says how many more match; headings with no rows are not shown", () => {
    const many = Array.from({ length: 12 }, (_, i) => t(`x${i}`, `Invoice ${String(i).padStart(2, "0")}`, i < 6 ? "GST" : "Accounting", i < 6 ? 1 : 5, i < 3));
    const r = matchTypes(many, "invoice");
    expect(ids(r)).toHaveLength(8);
    expect(r.more).toBe(4);
    expect(r.sections.every((s) => s.rows.length > 0)).toBe(true);
    expect(matchTypes(many, "invoice", { limit: 20 }).more).toBe(0);
  });

  it("a proposed type is marked so the field can say 'Proposed'", () => {
    const row = matchTypes(TYPES, "advice").sections[0].rows[0];
    expect(row.type).toMatchObject({ id: "prop", proposed: true });
  });
});

describe("no match (AC-5)", () => {
  it("caps close types at 3", () => {
    const four = ["a", "b", "c", "d"].map((k) => t(k, `Bank ${k} letter`, "Banking", 4, false));
    expect(matchTypes(four, "Bank zzz").close).toHaveLength(3);
  });

  it("offers up to 3 close types that share a word of 3+ letters, plan types first", () => {
    const r = matchTypes(TYPES, "Bank advise");
    expect(r.sections).toEqual([]);
    expect(r.close.map((x) => x.id)).toEqual(["prop", "bank"]); // share "bank"; Loan statement doesn't
    expect(r.noMatch).toBe(true);
  });

  it("offers nothing close when no word is shared", () => {
    const r = matchTypes(TYPES, "zz");
    expect(r).toMatchObject({ noMatch: true, close: [] });
  });
});

describe("speed (spec NFR)", () => {
  it("filters 500 types in under 16 ms", () => {
    const many = Array.from({ length: 500 }, (_, i) => t(`y${i}`, `Type ${i} statement`, `G${i % 10}`, i % 10, i % 7 === 0));
    matchTypes(many, "state"); // warm up
    const start = performance.now();
    for (let i = 0; i < 10; i++) matchTypes(many, "statement 4");
    expect((performance.now() - start) / 10).toBeLessThan(16);
  });
});
