import { describe, expect, it } from "vitest";
import { CLIENT_TYPES, validateClient } from "@/lib/validation/client";

// Spec 02 AC-8, AC-9: one validator for the Add client form and each CSV row.
const base = { name: "Zeta Traders", clientType: "proprietorship", inchargeId: "00000000-0000-4000-8000-000000000001" };

describe("validateClient", () => {
  it("has the 11 client types from intent decision 3", () => {
    expect(CLIENT_TYPES).toHaveLength(11);
  });

  it("accepts a minimal client (PAN optional) and normalises fields", () => {
    const r = validateClient({ ...base, pan: " aaapz9999z ", mobile: "+91 98765 43210", email: " Owner@Example.TEST " });
    expect(r.errors).toEqual([]);
    expect(r.data).toMatchObject({ pan: "AAAPZ9999Z", mobile: "9876543210", email: "owner@example.test" });
  });

  it("requires name, type and incharge", () => {
    const r = validateClient({ name: " ", clientType: "", inchargeId: "" });
    expect(r.errors.map((e) => e.field).sort()).toEqual(["clientType", "inchargeId", "name"]);
  });

  it("reports PAN/type mismatch as an error, society mismatch as a warning", () => {
    expect(validateClient({ ...base, pan: "AAACZ9999Z" }).errors[0]).toMatchObject({ field: "pan" });
    const soc = validateClient({ ...base, clientType: "society", pan: "AAATZ9999Z" });
    expect(soc.errors).toEqual([]);
    expect(soc.warnings[0]).toMatchObject({ field: "pan" });
  });

  it("GSTIN must contain the client's PAN; state is derived", () => {
    const ok = validateClient({ ...base, pan: "AAAPZ9999Z", registrations: [{ kind: "gstin", number: "33aaapz9999z1z5" }] });
    expect(ok.errors).toEqual([]);
    expect(ok.data?.registrations[0]).toEqual({ kind: "gstin", number: "33AAAPZ9999Z1Z5", stateCode: "33" });
    const bad = validateClient({ ...base, pan: "AAAPY9999Z", registrations: [{ kind: "gstin", number: "33AAAPZ9999Z1Z5" }] });
    expect(bad.errors[0]).toMatchObject({ field: "registrations.0.number" });
  });

  it("GSTIN without a client PAN is allowed (PAN optional) but TAN format is checked", () => {
    expect(validateClient({ ...base, registrations: [{ kind: "gstin", number: "33AAAPZ9999Z1Z5" }] }).errors).toEqual([]);
    expect(validateClient({ ...base, registrations: [{ kind: "tan", number: "CHE99999Z" }] }).errors[0])
      .toMatchObject({ field: "registrations.0.number" });
  });

  it("flags a duplicate registration on the row where it repeats", () => {
    const r = validateClient({ ...base, registrations: [
      { kind: "tan", number: "bad" }, { kind: "tan", number: "CHEZ99999Z" }, { kind: "tan", number: "chez99999z" },
    ] });
    expect(r.errors.map((e) => e.field)).toEqual(["registrations.0.number", "registrations.2.number"]);
  });

  it("limits previous reference to 60 characters and never echoes PAN values in messages", () => {
    expect(validateClient({ ...base, previousReference: "x".repeat(61) }).errors[0]).toMatchObject({ field: "previousReference" });
    const r = validateClient({ ...base, pan: "AAACZ9999Z" });
    expect(JSON.stringify(r.errors)).not.toContain("AAACZ9999Z");
  });
});
