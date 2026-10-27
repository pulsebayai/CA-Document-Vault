import { Badge } from "@/components/ui";
import { formatLabel, normaliseFormat } from "@/lib/validation/formats";

// Feature 11 (spec AC-16): a document filed outside the preference that applied when it was filed.
// The badge has text (not colour alone); the preference it missed is in the accessible name and, on the
// document page, written out next to it.

const FORMAT_NAME: Record<string, string> = {
  pdf: "PDF", jpg: "JPG", png: "PNG", heic: "HEIC", xlsx: "Excel", xls: "Excel", csv: "CSV", docx: "Word", zip: "ZIP",
};

export function FormatBadge({ preferred }: { preferred: string[] | null | undefined }) {
  if (!preferred?.length) return null;
  const wanted = formatLabel(preferred);
  return (
    <span title={`${wanted} preferred`}>
      <Badge tone="warn">Not preferred format<span className="sr-only"> ({wanted} preferred)</span></Badge>
    </span>
  );
}

/** "PDF · Excel or CSV preferred" for the document page. */
export function formatDetail(fileName: string | null | undefined, preferred: string[]): string {
  const f = fileName ? normaliseFormat(fileName) : null;
  const got = f ? FORMAT_NAME[f] ?? f.toUpperCase() : null;
  return `${got ? `${got} · ` : ""}${formatLabel(preferred)} preferred`;
}
