// Feature 10 AC-4 — ad-hoc notes are shown on the public upload page, so personal data is refused.
// The same patterns, in the same order, as private.note_pii in supabase/migrations/20261025132625_upload_links_staff.sql;
// tests/unit/upload-link-note.test.ts and tests/rls/upload-links-staff.test.ts share the vectors.

export type NotePii = "GSTIN" | "PAN" | "TAN" | "EMAIL" | "MOBILE" | "NUMBER";

export function notePii(note: string | null | undefined): NotePii | null {
  if (!note) return null;
  const up = note.toUpperCase();
  if (/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/.test(up)) return "GSTIN";
  if (/[A-Z]{5}[0-9]{4}[A-Z]/.test(up)) return "PAN";
  if (/[A-Z]{4}[0-9]{5}[A-Z]/.test(up)) return "TAN";
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(note)) return "EMAIL";
  if (/(91)?[6-9][0-9]{9}/.test(note.replace(/[\s().+-]/g, ""))) return "MOBILE";
  if (/[0-9]{9,}/.test(note.replace(/[\s-]/g, ""))) return "NUMBER";
  return null;
}

export const NOTE_MAX = 200;

export const NOTE_PII_MESSAGE = "Notes are shown to anyone with the link — remove numbers and IDs.";
