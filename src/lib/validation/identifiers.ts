import { GST_STATES } from "./gst-states";

/** Upper-case and strip spaces — how staff type or paste PAN/GSTIN/TAN. */
export function normaliseIdentifier(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase();
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
// state(2) + PAN(10) + entity number (1-9, A-Z) + 14th char (usually Z) + check character
const GSTIN_RE = /^([0-9]{2})([A-Z]{5}[0-9]{4}[A-Z])[1-9A-Z][0-9A-Z][0-9A-Z]$/;

export const isPan = (v: string) => PAN_RE.test(v);
export const isTan = (v: string) => TAN_RE.test(v);
export function isGstin(v: string): boolean {
  const m = GSTIN_RE.exec(v);
  return !!m && m[1] in GST_STATES;
}
export function gstinState(v: string): { code: string; name: string } | null {
  const code = v.slice(0, 2);
  return isGstin(v) ? { code, name: GST_STATES[code] } : null;
}
export const panOfGstin = (v: string) => v.slice(2, 12);

export type ClientType =
  | "individual" | "huf" | "proprietorship" | "partnership" | "llp" | "private_ltd"
  | "public_ltd" | "trust" | "society" | "aop_boi" | "cooperative";

/** Expected 4th PAN letter per client type (AC-9). Society/co-op are warn-only: their PANs vary in practice. */
const PAN_LETTERS: Record<ClientType, { letters: string; warnOnly?: boolean }> = {
  individual: { letters: "P" }, proprietorship: { letters: "P" }, huf: { letters: "H" },
  partnership: { letters: "F" }, llp: { letters: "F" }, private_ltd: { letters: "C" }, public_ltd: { letters: "C" },
  trust: { letters: "T" }, aop_boi: { letters: "AB" }, society: { letters: "A", warnOnly: true },
  cooperative: { letters: "A", warnOnly: true },
};
/** Government, local authority, artificial juridical person: rare edge cases — never block. */
const ALWAYS_WARN = "GLJ";

export function panMatchesType(pan: string, type: ClientType): "ok" | "warn" | "error" {
  const letter = pan[3];
  const rule = PAN_LETTERS[type];
  if (rule.letters.includes(letter)) return "ok";
  if (rule.warnOnly || ALWAYS_WARN.includes(letter)) return "warn";
  return "error";
}

/** 10-digit Indian mobile starting 6–9; accepts +91 / 0 prefixes, spaces and dashes. */
export function normaliseMobile(v: string): string | null {
  let d = v.replace(/[\s-]/g, "");
  if (d.startsWith("+91")) d = d.slice(3);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9][0-9]{9}$/.test(d) ? d : null;
}
