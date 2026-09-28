import { describe, expect, it } from "vitest";
import {
  gstinState, isGstin, isPan, isTan, normaliseMobile, normaliseIdentifier, panMatchesType, panOfGstin,
} from "@/lib/validation/identifiers";
import { GST_STATES } from "@/lib/validation/gst-states";

// Spec 02 AC-9. Synthetic identifiers only (AAAPZ9999Z-style); never real PANs/GSTINs in fixtures.
describe("PAN", () => {
  it("accepts AAAAA9999A after trimming/upper-casing", () => {
    expect(isPan("AAAPZ9999Z")).toBe(true);
    expect(isPan(normaliseIdentifier(" aaapz9999z "))).toBe(true);
  });
  it.each(["AAAPZ9999", "AAAP99999Z", "AAAPZ9999ZZ", "1AAPZ9999Z", ""])("rejects %s", (v) => {
    expect(isPan(v)).toBe(false);
  });
});

describe("PAN 4th letter vs client type", () => {
  it.each([
    ["AAAPZ9999Z", "individual"], ["AAAPZ9999Z", "proprietorship"], ["AAAHZ9999Z", "huf"],
    ["AAAFZ9999Z", "partnership"], ["AAAFZ9999Z", "llp"], ["AAACZ9999Z", "private_ltd"],
    ["AAACZ9999Z", "public_ltd"], ["AAATZ9999Z", "trust"], ["AAAAZ9999Z", "aop_boi"], ["AAABZ9999Z", "aop_boi"],
    ["AAAAZ9999Z", "society"], ["AAAAZ9999Z", "cooperative"],
  ] as const)("%s fits %s", (pan, type) => {
    expect(panMatchesType(pan, type)).toBe("ok");
  });
  it("a clear mismatch is an error (company PAN on an individual)", () => {
    expect(panMatchesType("AAACZ9999Z", "individual")).toBe("error");
  });
  it("society / co-operative mismatches only warn", () => {
    expect(panMatchesType("AAATZ9999Z", "society")).toBe("warn");
    expect(panMatchesType("AAAPZ9999Z", "cooperative")).toBe("warn");
  });
  it.each(["AAAGZ9999Z", "AAALZ9999Z", "AAAJZ9999Z"])("government / local authority / juridical letters (%s) warn, never block", (pan) => {
    expect(panMatchesType(pan, "trust")).toBe("warn");
  });
});

describe("GSTIN", () => {
  it("accepts 15 chars: state + PAN + entity + Z + check char", () => {
    expect(isGstin("33AAAPZ9999Z1Z5")).toBe(true);
  });
  it.each(["33AAAPZ9999Z1Z", "3AAAAPZ9999Z1Z5", "99AAAPZ9999Z1Z5X", "00AAAPZ9999Z1Z5", "33AAAPZ9999Z0Z5"])("rejects %s", (v) => {
    expect(isGstin(v)).toBe(false);
  });
  it("derives state from the first 2 digits and PAN from chars 3–12", () => {
    expect(gstinState("33AAAPZ9999Z1Z5")).toEqual({ code: "33", name: "Tamil Nadu" });
    expect(gstinState("34AAAPZ9999Z1Z5")?.name).toBe("Puducherry");
    expect(panOfGstin("33AAAPZ9999Z1Z5")).toBe("AAAPZ9999Z");
  });
  it("state list covers 01–38 and 97 (Other Territory)", () => {
    for (let i = 1; i <= 38; i++) expect(GST_STATES[String(i).padStart(2, "0")]).toBeTruthy();
    expect(GST_STATES["97"]).toBe("Other Territory");
  });
});

describe("TAN", () => {
  it("accepts AAAA99999A", () => expect(isTan("CHEZ99999Z")).toBe(true));
  it.each(["CHE999999Z", "CHEZ9999Z", "CHEZ99999"])("rejects %s", (v) => expect(isTan(v)).toBe(false));
});

describe("Indian mobile", () => {
  it.each([["9876543210", "9876543210"], ["+91 98765 43210", "9876543210"], ["098765-43210", "9876543210"]])(
    "normalises %s", (input, out) => expect(normaliseMobile(input)).toBe(out));
  it.each(["5876543210", "987654321", "98765432101", "abc"])("rejects %s", (v) => expect(normaliseMobile(v)).toBeNull());
});
