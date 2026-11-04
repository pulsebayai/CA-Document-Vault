"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { searchClients } from "@/lib/platform/actions";
import type { ClientRow, Page } from "@/lib/platform/queries";
import { Badge, Button, Card } from "@/components/ui";

const PAGE = 20;

/** Search and paging in the browser's state (search text never in the URL); each request is a logged view. */
export function ClientsBrowser({ firmId, initial }: { firmId: string; initial: Page<ClientRow> }) {
  const [data, setData] = useState(initial);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [closed, setClosed] = useState(false);
  const [pending, start] = useTransition();
  const load = (q: string, p: number) => start(async () => {
    const r = await searchClients(firmId, q, p);
    if (!r.ok) { setClosed(true); return; }
    setData(r.data); setPage(p);
  });
  const total = data.total ?? 0;
  if (closed) {
    return <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] text-bad">Read access has ended. Open it again on the Overview tab.</p>;
  }
  return (
    <div>
      <form role="search" className="mb-4 flex max-w-[440px] gap-2" onSubmit={(e) => { e.preventDefault(); load(query, 1); }}>
        <label htmlFor="pc-q" className="sr-only">Search clients by name or code</label>
        <input id="pc-q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or code" maxLength={100}
          className="w-full rounded-[10px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
        <Button type="submit" variant="secondary" disabled={pending}>Search</Button>
      </form>
      <p role="status" className="mb-2 text-[13.5px] text-ink-3">{pending ? "Loading…" : `${total} ${total === 1 ? "client" : "clients"}`}</p>
      <Card>
        <div className="relative overflow-x-auto focus-visible:outline-2 focus-visible:outline-accent" tabIndex={0} role="region" aria-label="The firm's clients">
          <table className="w-full min-w-[760px] text-left text-[13.5px]">
            <caption className="sr-only">The firm&apos;s clients</caption>
            <thead className="text-[13px] text-ink-3">
              <tr className="border-b border-line">
                {["Client", "Type", "PAN", "Email", "Mobile", "Incharge"].map((h, i) => <th key={h} scope="col" className={`${i ? "px-3" : "px-5"} py-3 font-normal`}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-3">
                    <Link href={`/platform/firms/${firmId}/clients/${c.id}`} className="font-medium text-accent underline-offset-2 hover:underline">{c.name}</Link>
                    <span className="ml-1.5 text-ink-3">{c.code}</span>
                    {c.archived && <span className="ml-1.5"><Badge tone="muted">Archived</Badge></span>}
                  </td>
                  <td className="px-3 py-3">{c.client_type.replace(/_/g, " ")}</td>
                  <td className="px-3 py-3 font-mono">{c.pan ?? "—"}</td>
                  <td className="px-3 py-3">{c.email ?? "—"}</td>
                  <td className="px-3 py-3">{c.mobile ?? "—"}</td>
                  <td className="px-3 py-3">{c.incharge_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.rows.length === 0 && <p className="px-5 py-6 text-ink-3">No clients found.</p>}
      </Card>
      {(page > 1 || page * PAGE < total) && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-end gap-2 text-[13.5px]">
          <Button type="button" size="sm" variant="secondary" disabled={page <= 1 || pending} onClick={() => load(query, page - 1)}>Previous</Button>
          <span className="text-ink-3">Page {page}</span>
          <Button type="button" size="sm" variant="secondary" disabled={page * PAGE >= total || pending} onClick={() => load(query, page + 1)}>Next</Button>
        </nav>
      )}
    </div>
  );
}
