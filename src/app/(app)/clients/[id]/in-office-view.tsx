"use client";

import Link from "next/link";
import type { ClientDocument } from "@/lib/documents/queries";
import { Card } from "@/components/ui";
import { DocumentRow } from "./document-row";

// Client › In office (13 AC-21; R1 feedback, Sankar 2026-11-12, round 2 the same day: "everything we physically hold"):
// every hard copy the firm is holding for this client, in any financial year and at any step: untagged, To review,
// Needs correction, reviewed but not yet placed, Document in office or Ready to dispatch, until it leaves in a live
// packet. Rows are 07/13's DocumentRow with their own state, so the review and custody actions (Mark in office included)
// and the "In office N days" badge work as on the Documents tab. Held longest first: since marked in office, else since
// received.

// A date-only received on sorts before any time marked in office the same day.
const heldSince = (d: ClientDocument) => d.inOfficeAt ?? d.receivedOn;

/** Physically in the office now: a hard copy not in a live packet. */
export function inOfficeDocuments(documents: ClientDocument[]): ClientDocument[] {
  return documents
    .filter((d) => (d.receivedAs === "hard_copy" || d.receivedAs === "original") && !d.dispatchedOn)
    .sort((a, b) => heldSince(a).localeCompare(heldSince(b)) || a.docCode.localeCompare(b.docCode));
}

export function InOfficeView({ clientId, clientName, documents, today }: {
  clientId: string; clientName: string; documents: ClientDocument[]; today: string;
}) {
  const held = inOfficeDocuments(documents);
  const unplaced = held.filter((d) => !d.custody).length;
  if (held.length === 0) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="font-medium">No hard copies in the office for this client.</p>
        <p className="mt-1 text-[13.5px] text-ink-2">Every hard copy received for this client shows here until it is dispatched.</p>
        <p className="mt-3 text-[13.5px]"><Link href={`/clients/${clientId}?tab=all`} className="font-medium text-accent hover:underline">See all documents</Link></p>
      </Card>
    );
  }
  return (
    <Card>
      <section aria-labelledby="in-office-h">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h3 id="in-office-h" className="font-semibold">Hard copies in office</h3>
          <span className="text-[13px] text-ink-3">
            {held.length} document{held.length === 1 ? "" : "s"}{unplaced > 0 ? ` · ${unplaced} not yet placed in office` : ""} · longest held first
          </span>
        </header>
        <ul aria-label="Hard copies in office" className="divide-y divide-line">
          {held.map((d) => <DocumentRow key={d.id} d={d} clientId={clientId} clientName={clientName} today={today} />)}
        </ul>
      </section>
    </Card>
  );
}
