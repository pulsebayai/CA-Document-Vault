import { z } from "zod";
import { normaliseEmail } from "@/lib/auth/roles";
import {
  type ClientType, isGstin, isPan, isTan, normaliseIdentifier, normaliseMobile, panMatchesType, panOfGstin,
} from "./identifiers";

/** Intent decision 3 (order = dropdown order). */
export const CLIENT_TYPES = [
  "individual", "huf", "proprietorship", "partnership", "llp", "private_ltd",
  "public_ltd", "trust", "society", "aop_boi", "cooperative",
] as const satisfies readonly ClientType[];

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  individual: "Individual", huf: "HUF", proprietorship: "Proprietorship", partnership: "Partnership firm",
  llp: "LLP", private_ltd: "Private Ltd", public_ltd: "Public Ltd", trust: "Trust", society: "Society",
  aop_boi: "AOP/BOI", cooperative: "Co-operative",
};

export type FieldIssue = { field: string; message: string };
export type Registration = { kind: "gstin" | "tan"; number: string; stateCode: string | null };
export type ClientInput = {
  name?: unknown; clientType?: unknown; pan?: unknown; previousReference?: unknown; email?: unknown;
  mobile?: unknown; inchargeId?: unknown; registrations?: { kind?: unknown; number?: unknown }[];
};
export type ValidClient = {
  name: string; clientType: ClientType; pan: string | null; previousReference: string | null;
  email: string | null; mobile: string | null; inchargeId: string; registrations: Registration[];
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const optional = (v: unknown) => str(v) || null;

/**
 * One validator for the Add/Edit client form and every CSV row (spec: "shared schemas").
 * Messages name the problem, never the value (no PAN/GSTIN/mobile in errors, logs or activity).
 */
export function validateClient(input: ClientInput): { data: ValidClient | null; errors: FieldIssue[]; warnings: FieldIssue[] } {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];

  const name = str(input.name);
  if (!name) errors.push({ field: "name", message: "Enter the client's name." });
  else if (name.length > 200) errors.push({ field: "name", message: "Name is too long (200 characters max)." });

  const clientType = str(input.clientType) as ClientType;
  const typeOk = (CLIENT_TYPES as readonly string[]).includes(clientType);
  if (!typeOk) errors.push({ field: "clientType", message: "Choose a client type." });

  const inchargeId = str(input.inchargeId);
  if (!z.uuid().safeParse(inchargeId).success) errors.push({ field: "inchargeId", message: "Choose an incharge." });

  const panRaw = optional(input.pan);
  const pan = panRaw ? normaliseIdentifier(panRaw) : null;
  if (pan && !isPan(pan)) errors.push({ field: "pan", message: "PAN must look like AAAAA9999A." });
  else if (pan && typeOk) {
    const fit = panMatchesType(pan, clientType);
    const msg = "The PAN's 4th letter doesn't match this client type.";
    if (fit === "error") errors.push({ field: "pan", message: msg });
    if (fit === "warn") warnings.push({ field: "pan", message: `${msg} Please double-check.` });
  }

  const previousReference = optional(input.previousReference);
  if (previousReference && previousReference.length > 60)
    errors.push({ field: "previousReference", message: "Previous reference is too long (60 characters max)." });

  const emailRaw = optional(input.email);
  const email = emailRaw ? normaliseEmail(emailRaw) : null;
  if (email && !z.email().safeParse(email).success) errors.push({ field: "email", message: "Enter a valid email address." });

  const mobileRaw = optional(input.mobile);
  const mobile = mobileRaw ? normaliseMobile(mobileRaw) : null;
  if (mobileRaw && !mobile) errors.push({ field: "mobile", message: "Enter a 10-digit Indian mobile number." });

  const registrations: Registration[] = [];
  const seen = new Set<string>();
  (input.registrations ?? []).forEach((r, i) => {
    const field = `registrations.${i}.number`;
    const number = normaliseIdentifier(str(r.number));
    if (number && seen.has(number)) return errors.push({ field, message: "This registration is listed twice." });
    seen.add(number);
    if (r.kind === "gstin") {
      if (!isGstin(number)) return errors.push({ field, message: "GSTIN must be 15 characters with a valid state code." });
      if (pan && panOfGstin(number) !== pan) return errors.push({ field, message: "This GSTIN does not contain the client's PAN." });
      registrations.push({ kind: "gstin", number, stateCode: number.slice(0, 2) });
    } else if (r.kind === "tan") {
      if (!isTan(number)) return errors.push({ field, message: "TAN must look like AAAA99999A." });
      registrations.push({ kind: "tan", number, stateCode: null });
    } else {
      errors.push({ field: `registrations.${i}.kind`, message: "Choose GSTIN or TAN." });
    }
  });

  const data = errors.length
    ? null
    : { name, clientType, pan, previousReference, email, mobile, inchargeId, registrations };
  return { data, errors, warnings };
}
