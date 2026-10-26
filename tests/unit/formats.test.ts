import { describe, expect, it } from "vitest";
import {
  FORMAT_CHOICES, formatLabel, isPreferred, isValidPreference, normaliseFormat, preferenceApplies, toStoredPreference,
} from "@/lib/validation/formats";

// Feature 11 — the format rule in TS (plan step 3). The SQL mirror is compared in tests/rls/format-check.test.ts.

describe("normaliseFormat", () => {
  it.each([
    ["statement.PDF", "pdf"], ["photo.jpeg", "jpg"], ["photo.JPG", "jpg"], ["xlsx", "xlsx"], [".csv", "csv"],
    ["office/x/doc/y/z.heic", "heic"], ["archive.tar.zip", "zip"],
  ])("%s → %s", (input, out) => expect(normaliseFormat(input)).toBe(out));

  it("returns null when there is nothing to read", () => {
    expect(normaliseFormat("")).toBeNull();
    expect(normaliseFormat("trailing.")).toBeNull();
  });
});

describe("isValidPreference (mirrors the database check)", () => {
  it("accepts null and any distinct subset of the choices", () => {
    expect(isValidPreference(null)).toBe(true);
    expect(isValidPreference(["xlsx", "xls", "csv"])).toBe(true);
    expect(isValidPreference([...FORMAT_CHOICES])).toBe(true);
  });
  it.each([[[]], [["zip"]], [["PDF"]], [["jpeg"]], [["pdf", "pdf"]], [["exe"]]])("refuses %j", (v) => {
    expect(isValidPreference(v)).toBe(false);
  });
});

describe("toStoredPreference", () => {
  it("empty → null; order follows the choices list", () => {
    expect(toStoredPreference([])).toBeNull();
    expect(toStoredPreference(["csv", "pdf", "xlsx"])).toEqual(["pdf", "xlsx", "csv"]);
    expect(toStoredPreference(["zip", "exe"])).toBeNull();
  });
});

describe("formatLabel", () => {
  it.each([
    [["xlsx", "xls", "csv"], "Excel or CSV"],
    [["pdf", "xlsx", "xls", "csv"], "PDF, Excel or CSV"],
    [["xlsx"], "Excel"],
    [["csv"], "CSV"],
    [["jpg", "png", "heic"], "Image"],
    [["docx"], "Word"],
    [["pdf", "docx"], "PDF or Word"],
    [[...FORMAT_CHOICES], "PDF, Excel, CSV, Image or Word"],
  ])("%j → %s", (v, label) => expect(formatLabel(v)).toBe(label));

  it("null or empty → null", () => {
    expect(formatLabel(null)).toBeNull();
    expect(formatLabel([])).toBeNull();
  });
});

describe("preferenceApplies and isPreferred", () => {
  const excel = ["xlsx", "xls", "csv"];
  it("no preference or an exception → nothing applies, every file is fine", () => {
    expect(preferenceApplies(null, false)).toBeNull();
    expect(preferenceApplies(excel, true)).toBeNull();
    expect(isPreferred("statement.pdf", preferenceApplies(excel, true))).toBe(true);
  });
  it("a preference applies → only its formats are preferred", () => {
    const applied = preferenceApplies(excel, false);
    expect(applied).toEqual(excel);
    expect(isPreferred("statement.pdf", applied)).toBe(false);
    expect(isPreferred("statement.CSV", applied)).toBe(true);
    expect(isPreferred("statement", applied)).toBe(false);
  });
  it("jpeg counts as jpg", () => expect(isPreferred("scan.jpeg", ["jpg"])).toBe(true));
});
