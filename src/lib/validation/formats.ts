// Feature 11 — preferred file formats (spec AC-1, AC-2, AC-9, AC-19, AC-20; plan step 3).
// One rule in three places, tested equal: this file, public.format_label / public.format_of_path (SQL), and the
// format check in 03's filing trigger (private.format_check). Change all three together.

/** 03's allow-list minus ZIP (spec S5): the formats a type may prefer. */
export const FORMAT_CHOICES = ["pdf", "jpg", "png", "heic", "xlsx", "xls", "csv", "docx"] as const;
export type FormatChoice = (typeof FORMAT_CHOICES)[number];

const CHOICE_SET: ReadonlySet<string> = new Set(FORMAT_CHOICES);

/** Labels for the catalogue checkboxes. */
export const FORMAT_CHOICE_LABELS: Record<FormatChoice, string> = {
  pdf: "PDF",
  jpg: "JPG",
  png: "PNG",
  heic: "HEIC",
  xlsx: "XLSX",
  xls: "XLS",
  csv: "CSV",
  docx: "DOCX",
};

/** A file's format = its extension, lower case, jpeg → jpg. Accepts a bare extension, a file name or a path. */
export function normaliseFormat(nameOrExt: string): string | null {
  const m = /(?:^|\.)([A-Za-z0-9]+)$/.exec(nameOrExt.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/** A valid preference: null, or 1–8 distinct format choices (the database check says the same). */
export function isValidPreference(formats: readonly string[] | null): boolean {
  if (formats === null) return true;
  if (formats.length === 0) return false;
  return formats.every((f) => CHOICE_SET.has(f)) && new Set(formats).size === formats.length;
}

/** Form input → stored value: an empty selection is null; order follows FORMAT_CHOICES. */
export function toStoredPreference(selected: readonly string[]): FormatChoice[] | null {
  const picked = FORMAT_CHOICES.filter((f) => selected.includes(f));
  return picked.length ? picked : null;
}

/** "Excel or CSV", "PDF, Excel or CSV", "Image", "Word" … in a fixed order: PDF · Excel · CSV · Image · Word. */
export function formatLabel(formats: readonly string[] | null): string | null {
  if (!formats?.length) return null;
  const has = (...xs: string[]) => xs.some((x) => formats.includes(x));
  const parts = [
    has("pdf") && "PDF",
    has("xlsx", "xls") && "Excel",
    has("csv") && "CSV",
    has("jpg", "png", "heic") && "Image",
    has("docx") && "Word",
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/** The preference that applies to a client + type: none when the type has none or the client has an exception. */
export function preferenceApplies(typePreferred: readonly string[] | null | undefined, clientAnyFormat: boolean): readonly string[] | null {
  if (!typePreferred?.length || clientAnyFormat) return null;
  return typePreferred;
}

/** Whether a file is in a preferred format; true when no preference applies (nothing to warn about). */
export function isPreferred(fileNameOrExt: string, applied: readonly string[] | null): boolean {
  if (!applied?.length) return true;
  const f = normaliseFormat(fileNameOrExt);
  return f !== null && applied.includes(f);
}
