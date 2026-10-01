import type { ClientTypes, PeriodOption } from "@/lib/documents/queries";
import { allowedPeriodKinds } from "@/lib/documents/period";

// Feature 04 step 5 — Add document opened from an expected row ("Upload", spec AC-8):
// /documents/new?client=&type=&period=&registration=&from=  (UUIDs only — never names, GSTINs or dates).
// Each value is kept only if it is valid for this client: the type is one the client can file, the period exists and
// its kind is allowed for the type, the registration is the client's own of the type's kind. Anything else is dropped,
// and the form falls back to its normal defaults (03 AC-3), so a stale or hand-edited link can't file something odd.

export type Prefill = { docTypeId: string; periodId: string; registrationId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (typeof v === "string" && UUID.test(v) ? v : null);

export function prefillFrom(
  sp: { type?: string | string[]; period?: string | string[]; registration?: string | string[] },
  types: ClientTypes, periods: PeriodOption[],
): Prefill | null {
  const typeId = one(sp.type);
  const type = typeId ? [...types.planTypes, ...types.otherTypes].find((t) => t.id === typeId) : undefined;
  if (!type) return null;
  const periodId = one(sp.period);
  const period = periodId ? periods.find((p) => p.id === periodId) : undefined;
  const okPeriod = period && type.periodKind !== "none" && allowedPeriodKinds(type.periodKind).includes(period.kind) ? period : undefined;
  const regId = one(sp.registration);
  const ofKind = type.registrationKind ? types.registrations.filter((r) => r.kind === type.registrationKind) : [];
  // As the form does when a type is picked: the client's only registration of that kind is chosen by default.
  const reg = (regId ? ofKind.find((r) => r.id === regId) : undefined) ?? (ofKind.length === 1 ? ofKind[0] : undefined);
  return { docTypeId: type.id, periodId: okPeriod?.id ?? "", registrationId: reg?.id ?? "" };
}

/** Where Add document returns to after saving from the Expected tab (the tab itself, so the flipped row is visible). */
export const expectedTabPath = (clientId: string) => `/clients/${clientId}?tab=expected`;
