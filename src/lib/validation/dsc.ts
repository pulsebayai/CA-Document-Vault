// Feature 14 (spec AC-2, AC-4, AC-5, AC-8, AC-10) — the DSC fields staff fill in. Pure, so it is unit-tested; the
// server actions apply it before calling the dsc_* functions, which check the same limits again.

export type DscClass = "class3" | "dgft" | "other";
export const DSC_CLASSES: Array<{ value: DscClass; label: string }> = [
  { value: "class3", label: "Class 3" },
  { value: "dgft", label: "DGFT" },
  { value: "other", label: "Other" },
];
export const DSC_ISSUERS = ["eMudhra", "Capricorn", "Pantasign", "VSign", "IDSign", "Other"];
export const dscClassLabel = (c: string | null | undefined) => DSC_CLASSES.find((x) => x.value === c)?.label ?? null;

export const MAX_PASSWORD = 100;

type Issue<F extends string> = { field: F; message: string };
export type DscField = "clientId" | "holderName" | "expiresOn" | "password" | "dscClass" | "issuer" | "tokenNote";
export type ValidDsc = {
  clientId: string; holderName: string; expiresOn: string; password: string | null;
  dscClass: DscClass | null; issuer: string | null; tokenNote: string | null;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

function passwordError(value: string): string | null {
  if (value.length === 0) return "Enter the token PIN / password.";
  if (value.length > MAX_PASSWORD) return `Too long (${MAX_PASSWORD} characters max).`;
  return null;
}

/** On create the password is required; on edit it is ignored (it changes only through Change password, AC-4). */
export function validateDsc(input: Record<string, unknown>, opts: { create: boolean }): { data: ValidDsc | null; errors: Issue<DscField>[] } {
  const errors: Issue<DscField>[] = [];
  const clientId = str(input.clientId);
  if (opts.create && !UUID.test(clientId)) errors.push({ field: "clientId", message: "Choose the client." });
  const holderName = str(input.holderName);
  if (!holderName) errors.push({ field: "holderName", message: "Enter the holder's name." });
  else if (holderName.length > 120) errors.push({ field: "holderName", message: "Too long (120 characters max)." });
  const expiresOn = str(input.expiresOn);
  if (!isRealDate(expiresOn)) errors.push({ field: "expiresOn", message: "Enter the expiry date." });
  let password: string | null = null;
  if (opts.create) {
    const raw = typeof input.password === "string" ? input.password : ""; // kept exactly as typed: spaces may be part of a PIN
    const e = passwordError(raw);
    if (e) errors.push({ field: "password", message: e });
    else password = raw;
  }
  const classText = str(input.dscClass);
  const dscClass = (classText || null) as DscClass | null;
  if (dscClass && !DSC_CLASSES.some((c) => c.value === dscClass)) errors.push({ field: "dscClass", message: "Choose a class from the list." });
  const issuer = str(input.issuer) || null;
  if (issuer && issuer.length > 80) errors.push({ field: "issuer", message: "Too long (80 characters max)." });
  const tokenNote = str(input.tokenNote) || null;
  if (tokenNote && tokenNote.length > 200) errors.push({ field: "tokenNote", message: "Too long (200 characters max)." });
  if (errors.length) return { data: null, errors };
  return { data: { clientId, holderName, expiresOn, password, dscClass, issuer, tokenNote }, errors };
}

/** Change password: typed twice (AC-4). */
export function validatePassword(value: unknown, confirm: unknown): { value: string | null; error: string | null } {
  const v = typeof value === "string" ? value : "";
  const e = passwordError(v);
  if (e) return { value: null, error: e };
  if (v !== confirm) return { value: null, error: "The two passwords don't match." };
  return { value: v, error: null };
}

export type CustodyField = "personName" | "onDate" | "note";
export function validateCustody(input: Record<string, unknown>, today: string): { data: { personName: string; onDate: string; note: string | null } | null; errors: Issue<CustodyField>[] } {
  const errors: Issue<CustodyField>[] = [];
  const personName = str(input.personName);
  if (!personName) errors.push({ field: "personName", message: "Enter the name." });
  else if (personName.length > 120) errors.push({ field: "personName", message: "Too long (120 characters max)." });
  const onDate = str(input.onDate) || today;
  if (!isRealDate(onDate)) errors.push({ field: "onDate", message: "Enter a valid date." });
  else if (onDate > today) errors.push({ field: "onDate", message: "The date can't be in the future." });
  const note = str(input.note) || null;
  if (note && note.length > 200) errors.push({ field: "note", message: "Too long (200 characters max)." });
  if (errors.length) return { data: null, errors };
  return { data: { personName, onDate, note }, errors };
}

export function validateRemindDays(value: unknown): { value: number | null; error: string | null } {
  const t = typeof value === "number" ? String(value) : str(value);
  const n = /^\d{1,3}$/.test(t) ? Number(t) : NaN;
  if (!(n >= 1 && n <= 180)) return { value: null, error: "Enter 1 to 180 days." };
  return { value: n, error: null };
}

export function validateArchiveReason(value: unknown): { value: string | null; error: string | null } {
  const v = str(value);
  if (!v) return { value: null, error: "Enter a reason." };
  if (v.length > 500) return { value: null, error: "Too long (500 characters max)." };
  return { value: v, error: null };
}
