"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ClientDocument } from "@/lib/documents/queries";
import { Badge, Card } from "@/components/ui";
import { FileButtons } from "../../documents/file-buttons";

// Client › Documents (mockup 10 without expected/overdue/remind/review — those come with 04/06/07; spec AC-10).
// Grouped group → type → period (newest period first). Filters: FY (default the current one) and group.

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export function DocumentsView({ clientId, documents, currentFy }: { clientId: string; documents: ClientDocument[]; currentFy: string }) {
  const fys = useMemo(() => [...new Set([currentFy, ...documents.map((d) => d.fyCode)])].sort().reverse(), [documents, currentFy]);
  const [fy, setFy] = useState(currentFy);
  const [group, setGroup] = useState("");
  const inFy = documents.filter((d) => d.fyCode === fy);
  const groups = [...new Map(documents.map((d) => [d.groupId, { id: d.groupId, name: d.groupName, sort: d.groupSort }])).values()]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const shown = inFy.filter((d) => !group || d.groupId === group);
  const byGroup = groups
    .map((g) => ({
      ...g,
      docs: shown.filter((d) => d.groupId === g.id).sort((a, b) =>
        a.typeName.localeCompare(b.typeName) || (b.periodStart ?? "").localeCompare(a.periodStart ?? "") || b.receivedOn.localeCompare(a.receivedOn)),
    }))
    .filter((g) => g.docs.length);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13.5px]">Financial year
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-[9px] border border-line-2 bg-panel px-2 py-1.5">
            {fys.map((f) => <option key={f} value={f}>FY {f}</option>)}
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
                <header className="flex items-center justify-between border-b border-line px-5 py-3">
                  <h3 id={`grp-${g.id}`} className="font-semibold">{g.name}</h3>
                  <span className="text-[13px] text-ink-3">{g.docs.length} document{g.docs.length === 1 ? "" : "s"}</span>
                </header>
                <ul aria-label={`${g.name} documents`} className="divide-y divide-line">
                  {g.docs.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <Link href={`/documents/${d.id}`} className="break-words font-medium hover:underline">
                          {d.typeName}{d.periodLabel ? ` · ${d.periodLabel}` : ""}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-2">
                          <span>Received {day.format(new Date(`${d.receivedOn}T00:00:00+05:30`))} by {d.receivedBy}</span>
                          <span className="text-ink-3">{d.docCode}</span>
                          {d.receivedAs === "hard_copy" && <Badge tone="warn">Hard copy</Badge>}
                          {d.receivedAs === "original" && <Badge tone="bad">Original</Badge>}
                          {d.versionCount > 1 && <Badge tone="muted">{d.versionCount} versions</Badge>}
                          {d.proposed && <Badge tone="accent">Proposed type</Badge>}
                        </p>
                      </div>
                      {d.current && <FileButtons versionId={d.current.id} mimeType={d.current.mimeType} docCode={d.docCode} />}
                    </li>
                  ))}
                </ul>
              </section>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
