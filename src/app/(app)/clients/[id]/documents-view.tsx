"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ClientDocument } from "@/lib/documents/queries";
import { openForCards, type ExpectedItem } from "@/lib/expected/shape";
import { Badge, Card } from "@/components/ui";
import { DocumentRow } from "./document-row";
import { itemLabel, uploadHref } from "./expected-view";

// Client › Documents (mockup 10; 03 spec AC-10, 04 AC-14). Grouped group → type → period (newest period first).
// Filters: FY (default the current one) and group. 04: each group card lists its open expected items first
// (Overdue, then Due, with Upload), then the received documents; a collected group with nothing open and no
// documents says "All caught up". Waive / Reopen / Undo live on the Expected tab.

/** Mockup 10 caps a card ("10 more · Show all"); the rest are one click away on the Expected tab. */
export const CARD_OPEN_LIMIT = 5;

type Props = {
  clientId: string;
  documents: ClientDocument[];
  currentFy: string;
  /** 04: the client's expected items (any status; only open ones are shown), its collected groups and the FY codes. */
  expected?: ExpectedItem[];
  planGroups?: Array<{ id: string; name: string; sort: number }>;
  fys?: Array<{ id: string; code: string }>;
  /** Upload from a card (not on an archived client). */
  canUpload?: boolean;
  /** 07: India date (from the server, so the state text and held days don't depend on the browser clock). */
  today?: string;
  /** 07: shown in the dispatch dialog's heading. */
  clientName?: string;
};

export function DocumentsView({ clientId, documents, currentFy, expected = [], planGroups = [], fys = [], canUpload = false, today, clientName }: Props) {
  const fyCode = useMemo(() => new Map(fys.map((f) => [f.id, f.code])), [fys]);
  const codeOf = (id: string) => fyCode.get(id) ?? "";
  const fyList = useMemo(
    () => [...new Set([currentFy, ...documents.map((d) => d.fyCode), ...expected.filter((i) => i.open).map((i) => fyCode.get(i.fyId) ?? "")].filter(Boolean))]
      .sort().reverse(),
    [documents, expected, currentFy, fyCode],
  );
  const [fy, setFy] = useState(currentFy);
  const [group, setGroup] = useState("");
  const inFy = documents.filter((d) => d.fyCode === fy);
  const open = openForCards(expected, codeOf, fy, currentFy);
  const planIds = new Set(planGroups.map((g) => g.id));
  const groups = [...new Map([
    ...planGroups.map((g) => [g.id, g] as const),
    ...documents.map((d) => [d.groupId, { id: d.groupId, name: d.groupName, sort: d.groupSort }] as const),
  ]).values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  // Open items of a group the client no longer collects still show (they are owed); find its name from the item.
  for (const i of open) if (!groups.some((g) => g.id === i.groupId)) groups.push({ id: i.groupId, name: i.groupName, sort: Number.MAX_SAFE_INTEGER });
  const shown = inFy.filter((d) => !group || d.groupId === group);
  const byGroup = groups
    .filter((g) => !group || g.id === group)
    .map((g) => ({
      ...g,
      open: open.filter((i) => i.groupId === g.id),
      docs: shown.filter((d) => d.groupId === g.id).sort((a, b) =>
        a.typeName.localeCompare(b.typeName) || (b.periodStart ?? "").localeCompare(a.periodStart ?? "") || b.receivedOn.localeCompare(a.receivedOn)),
    }))
    // A collected group with nothing open and no documents gets an "All caught up" card — for the current FY only:
    // in a past FY the client may not have been collected for that group at all (review nit 6).
    .filter((g) => g.docs.length || g.open.length || (fy === currentFy && planIds.has(g.id)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13.5px]">Financial year
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-[9px] border border-line-2 bg-panel px-2 py-1.5">
            {fyList.map((f) => <option key={f} value={f}>FY {f}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13.5px]">Group
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded-[9px] border border-line-2 bg-panel px-2 py-1.5">
            <option value="">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <span className="text-[13px] text-ink-3">{shown.length} document{shown.length === 1 ? "" : "s"}</span>
      </div>

      {byGroup.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="font-medium">No documents received for FY {fy}{group ? " in this group" : ""} yet.</p>
          <Link href={`/documents/new?client=${clientId}&from=/clients/${clientId}`} className="mt-3 inline-flex rounded-[9px] bg-accent px-3.5 py-2 font-medium text-white hover:bg-[#264d8f]">Add document</Link>
        </Card>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
          {byGroup.map((g) => (
            <Card key={g.id}>
              <section aria-labelledby={`grp-${g.id}`}>
                <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
                  <h3 id={`grp-${g.id}`} className="font-semibold">{g.name}</h3>
                  <span className="text-right text-[13px] text-ink-3">
                    {g.open.length > 0 && <>{g.open.length} open · </>}{g.docs.length} document{g.docs.length === 1 ? "" : "s"}
                  </span>
                </header>
                {g.open.length > 0 && (
                  <div className="border-b border-line">
                    <ul aria-label={`${g.name} outstanding`} className="divide-y divide-line">
                      {g.open.slice(0, CARD_OPEN_LIMIT).map((i) => <OpenRow key={i.id} clientId={clientId} item={i} canUpload={canUpload} />)}
                    </ul>
                    {g.open.length > CARD_OPEN_LIMIT && (
                      <p className="border-t border-line px-5 py-2.5 text-[13.5px] text-ink-2">
                        {g.open.length - CARD_OPEN_LIMIT} more open ·{" "}
                        <Link href={`/clients/${clientId}?tab=expected`} className="font-medium text-accent hover:underline">Show all on Expected</Link>
                      </p>
                    )}
                  </div>
                )}
                {g.docs.length > 0 && (
                  <ul aria-label={`${g.name} documents`} className="divide-y divide-line">
                    {g.docs.map((d) => <DocumentRow key={d.id} d={d} clientId={clientId} clientName={clientName} today={today ?? indiaToday()} />)}
                  </ul>
                )}
                {g.open.length === 0 && g.docs.length === 0 && (
                  <p className="px-5 py-4 text-[13.5px] text-ink-2">All caught up for FY {fy}</p>
                )}
              </section>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** Mockup 10: "Invoices · August 2026 / Not received · 13 days late", red "Overdue", Upload. */
function OpenRow({ clientId, item: i, canUpload }: { clientId: string; item: ExpectedItem; canUpload: boolean }) {
  const label = itemLabel(i);
  const overdue = i.state.kind === "overdue";
  const sub = overdue ? `Not received · ${i.state.text.replace(/^Overdue · /, "")}` : `Not received · ${i.state.text}`;
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">{label}</p>
        <p className={`mt-0.5 text-[13px] ${overdue ? "text-bad" : i.state.kind === "due_today" ? "text-warn" : "text-ink-2"}`}>{sub}</p>
      </div>
      {overdue ? <Badge tone="bad">Overdue</Badge> : <Badge tone={i.state.kind === "due_today" ? "warn" : "muted"}>{i.state.kind === "due_today" ? "Due today" : "Due"}</Badge>}
      {canUpload && (
        <Link href={uploadHref(clientId, i, `/clients/${clientId}`)} aria-label={`Upload ${label}`}
          className="inline-flex h-[30px] items-center rounded-[7px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-[#264d8f]">Upload</Link>
      )}
    </li>
  );
}

/** Fallback "today" when the caller passes none (older callers/tests): the browser's India date. */
function indiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
