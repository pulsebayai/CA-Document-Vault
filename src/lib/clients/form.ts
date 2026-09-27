import type { ClientInput } from "@/lib/validation/client";

// Pure helpers for the Add/Edit client form (spec 02 AC-8 … AC-11). Kept out of the server action
// file so they can be unit-tested.

export type ClientFormInput = ClientInput & { groupIds: string[] };

/** Reads the form. Registration rows with an empty number are ignored (the form always shows one blank row). */
export function clientInputFromForm(fd: FormData): ClientFormInput {
  const get = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : "");
  const kinds = fd.getAll("regKind").map(String);
  const numbers = fd.getAll("regNumber").map(String);
  const registrations = numbers
    .map((number, i) => ({ kind: kinds[i] ?? "", number }))
    .filter((r) => r.number.trim() !== "");
  return {
    name: get("name"), clientType: get("clientType"), pan: get("pan"), previousReference: get("previousReference"),
    email: get("email"), mobile: get("mobile"), inchargeId: get("inchargeId"), registrations,
    groupIds: [...new Set(fd.getAll("groupIds").map(String))],
  };
}

/**
 * Database refusals → plain words (architecture: plain user messages; never echo the identifier values).
 * Unknown errors get a generic message; the caller logs only the error code.
 */
export function clientErrorMessage(message: string | undefined): { field?: string; message: string } {
  const m = message ?? "";
  if (/client_pan_active_key/.test(m)) return { field: "pan", message: "Another active client already has this PAN." };
  if (/client_registration_office_id_number_key/.test(m)) return { field: "registrations", message: "One of these GSTINs/TANs is already on another client." };
  if (/GSTIN_PAN/.test(m)) return { field: "pan", message: "The PAN can't change while this client has a GSTIN with the old PAN on record." };
  if (/client_pan_fits_type/.test(m)) return { field: "pan", message: "The PAN's 4th letter doesn't match this client type." };
  if (/INCHARGE/.test(m)) return { field: "inchargeId", message: "Choose an active staff member as incharge." };
  if (/ARCHIVED/.test(m)) return { message: "This client is archived. Unarchive it before editing." };
  if (/ROLE_REQUIRED|row-level security|permission denied/.test(m)) return { message: "You don't have permission to do this." };
  if (/NOT_FOUND/.test(m)) return { message: "This client no longer exists or you can't see it." };
  if (/IMMUTABLE: registration kind/.test(m)) return { field: "registrations", message: "A number can't switch between GSTIN and TAN." };
  return { message: "Something went wrong. Please try again." };
}
