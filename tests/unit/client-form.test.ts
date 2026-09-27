import { describe, expect, it } from "vitest";
import { clientErrorMessage, clientInputFromForm } from "@/lib/clients/form";

// Spec 02 AC-8 … AC-11: form parsing and plain-word errors (never echoing PAN/GSTIN values).
describe("clientInputFromForm", () => {
  it("pairs registration kinds with numbers and drops blank rows; de-duplicates groups", () => {
    const fd = new FormData();
    fd.set("name", "Zeta"); fd.set("clientType", "llp"); fd.set("inchargeId", "i1");
    fd.append("regKind", "gstin"); fd.append("regNumber", "33ZZZFZ1234Z1Z5");
    fd.append("regKind", "tan"); fd.append("regNumber", "  ");
    fd.append("regKind", "tan"); fd.append("regNumber", "ZZZZ12345Z");
    fd.append("groupIds", "g1"); fd.append("groupIds", "g1"); fd.append("groupIds", "g2");
    const r = clientInputFromForm(fd);
    expect(r.registrations).toEqual([{ kind: "gstin", number: "33ZZZFZ1234Z1Z5" }, { kind: "tan", number: "ZZZZ12345Z" }]);
    expect(r.groupIds).toEqual(["g1", "g2"]);
    expect(r).toMatchObject({ name: "Zeta", clientType: "llp", inchargeId: "i1", pan: "", email: "" });
  });
});

describe("clientErrorMessage", () => {
  it("maps database refusals to fields and plain words", () => {
    expect(clientErrorMessage('duplicate key value violates unique constraint "client_pan_active_key"')).toEqual({ field: "pan", message: "Another active client already has this PAN." });
    expect(clientErrorMessage('duplicate key value violates unique constraint "client_registration_office_id_number_key"').field).toBe("registrations");
    expect(clientErrorMessage("GSTIN_PAN: the new PAN does not match").field).toBe("pan");
    expect(clientErrorMessage("ROLE_REQUIRED: only Admin").message).toBe("You don't have permission to do this.");
    expect(clientErrorMessage("ARCHIVED: unarchive").message).toMatch(/archived/);
    expect(clientErrorMessage(undefined).message).toBe("Something went wrong. Please try again.");
  });
  it("never echoes identifier values from the database message", () => {
    const m = clientErrorMessage('Key (office_id, number)=(x, 33ZZZFZ1234Z1Z5) already exists. client_registration_office_id_number_key').message;
    expect(m).not.toMatch(/33ZZZ/);
  });
});
