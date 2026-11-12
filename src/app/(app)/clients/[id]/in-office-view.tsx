"use client";

import Link from "next/link";
import type { ClientDocument } from "@/lib/documents/queries";
import { Card } from "@/components/ui";
import { DocumentRow } from "./document-row";

// Client › In office (13 AC-21; R1 feedback, Sankar 2026-11-12): every hard copy the firm is holding for this client,
// in any financial year: a custody step set (Document in office or Ready to dispatch) and not in a live packet. It is
// the same set as /documents' Custody = In office + Ready (private.custody_state), so a copy that shows Needs correction
// or To review (13 AC-5) is still listed, with its own badge. Rows are 07/13's DocumentRow, so the custody actions and
// the "In office N days" badge work as on the Documents tab. Held longest first.

/** Physically in the office now: a custody step and no live packet (the caller passes documents that have a step). */
export function inOfficeDocuments(documents: ClientDocument[]): ClientDocument[] {
  return documents
    .filter((d) => d.receivedAs === "hard_copy" && !!d.custody && !d.dispatchedOn)
    .sort((a, b) => (a.inOfficeAt ?? "").localeCompare(b.inOfficeAt ?? "") || a.docCode.localeCompare(b.docCode));
}

export function InOfficeView({ clientId, clientName, documents, today }: {
  clientId: string; clientName: string; documents: ClientDocument[]; today: string;
}) {
  const held = inOfficeDocuments(documents);
  if (held.length === 0) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="font-medium">No hard copies in the office for this client.</p>
        <p className="mt-1 text-[13.5px] text-ink-2">A hard copy shows here once it is marked <em>Document in office</em>, until it is dispatched.</p>
        <p className="mt-3 text-[13.5px]"><Link href={`/clients/${clientId}?tab=all`} className="font-medium text-accent hover:underline">See all documents</Link></p>
      </Card>
    );
  }
  return (
    <Card>
      <section aria-labelledby="in-office-h">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h3 id="in-office-h" className="font-semibold">Hard copies in office</h3>
          <span className="text-[13px] text-ink-3">{held.length} document{held.length === 1 ? "" : "s"} · longest held first</span>
        </header>
        <ul aria-label="Hard copies in office" className="divide-y divide-line">
          {held.map((d) => <DocumentRow key={d.id} d={d} clientId={clientId} clientName={clientName} today={today} />)}
        </ul>
      </section>
    </Card>
  );
}
