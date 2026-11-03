import { z } from "zod";

// Feature 17 (spec AC-9): the firm's name (required) and branch (optional), as an Admin edits them on Settings › Office.
// The database checks the same limits (office.name 1–120, office.branch null or 1–120).

const text = (label: string) => z.string().transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(z.string().max(120, `${label} can be at most 120 characters.`));

export const officeSchema = z.object({
  name: text("Firm name").pipe(z.string().min(1, "Enter the firm's name.")),
  branch: text("Branch").transform((s) => (s === "" ? null : s)),
});

export type OfficeInput = z.infer<typeof officeSchema>;

/** Field names that differ (for the activity row: names only, never the values). */
export function changedFields(before: OfficeInput, after: OfficeInput): Array<keyof OfficeInput> {
  return (["name", "branch"] as const).filter((k) => (before[k] ?? null) !== (after[k] ?? null));
}
