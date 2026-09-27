"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { searchClients } from "@/lib/clients/actions";
import type { ClientSearchResult, StaffOption } from "@/lib/clients/queries";
import { CLIENT_TYPES, CLIENT_TYPE_LABEL } from "@/lib/validation/client";
import { PAGE_SIZE } from "@/lib/validation/client-search";
import { Button } from "@/components/ui";
import { ClientsView } from "./clients-view";

type Filters = { query: string; clientType: string; inchargeId: string; includeArchived: boolean; page: number };
const EMPTY: Filters = { query: "", clientType: "", inchargeId: "", includeArchived: false, page: 1 };

const control = "h-9 rounded-full border border-line-2 bg-panel px-3 text-[13.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft";

/**
 * Clients list with search/filters (mockup 03, spec AC-7). State lives only in this component and is sent
 * to a server action (POST). Inputs have no `name`, so even a pre-hydration submit puts nothing in the URL.
 */
export function ClientsBrowser({ initial, staff }: { initial: ClientSearchResult; staff: StaffOption[] }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [data, setData] = useState<ClientSearchResult>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const requestId = useRef(0);
  const firstRender = useRef(true);

  const run = (f: Filters) => {
    const id = ++requestId.current;
    start(async () => {
      const r = await searchClients({
        query: f.query, clientType: f.clientType || null, inchargeId: f.inchargeId || null,
        includeArchived: f.includeArchived, page: f.page,
      });
      if (id !== requestId.current) return; // a newer search has started
      if (r.ok) { setData(r); setError(null); } else setError(r.error);
    });
  };

  // Typing is debounced; other filters apply immediately (their setters bump `page` to 1 too).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const t = setTimeout(() => run(filters), filters.query ? 300 : 0);
    return () => clearTimeout(t);
  }, [filters]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  const filtered = !!(filters.query.trim() || filters.clientType || filters.inchargeId || filters.includeArchived);
  const pages = Math.max(1, Math.ceil(data.matched / PAGE_SIZE));

  const toolbar = (
    <form role="search" aria-label="Search and filter clients" className="mb-4 flex flex-wrap items-center gap-2"
      onSubmit={(e) => { e.preventDefault(); run(filters); }}>
      <div className="relative w-full max-w-[440px]">
        <svg aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input type="search" aria-label="Search clients" placeholder="Name, code, PAN, GSTIN or previous reference" autoComplete="off"
          value={filters.query} onChange={(e) => set({ query: e.target.value })} maxLength={100}
          className="h-10 w-full rounded-[10px] border border-line-2 bg-panel pl-9 pr-3 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
      </div>
      <select aria-label="Type" value={filters.clientType} onChange={(e) => set({ clientType: e.target.value })} className={control}>
        <option value="">Type: all</option>
        {CLIENT_TYPES.map((t) => <option key={t} value={t}>{CLIENT_TYPE_LABEL[t]}</option>)}
      </select>
      <select aria-label="Incharge" value={filters.inchargeId} onChange={(e) => set({ inchargeId: e.target.value })} className={control}>
        <option value="">Incharge: all</option>
        {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <label className={`${control} flex cursor-pointer items-center gap-2`}>
        <input type="checkbox" checked={filters.includeArchived} onChange={(e) => set({ includeArchived: e.target.checked })} className="h-4 w-4 accent-accent" />
        Show archived
      </label>
      {filtered && <Button type="button" size="sm" variant="secondary" onClick={() => setFilters(EMPTY)}>Clear</Button>}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? "Searching…" : `${data.matched} ${data.matched === 1 ? "client" : "clients"} found`}
      </span>
      {error && (
        <p role="alert" className="flex w-full items-center gap-3 text-[13.5px] text-bad">
          {error} <Button type="submit" size="sm" variant="secondary">Retry</Button>
        </p>
      )}
    </form>
  );

  const pager = pages > 1 ? (
    <span className="flex items-center gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={pending || filters.page <= 1}
        onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>Previous</Button>
      <span>Page {filters.page} of {pages}</span>
      <Button type="button" size="sm" variant="secondary" disabled={pending || filters.page >= pages}
        onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>Next</Button>
    </span>
  ) : undefined;

  return (
    <ClientsView clients={data.rows} total={data.total} matched={data.matched} filtered={filtered}
      firstIndex={(filters.page - 1) * PAGE_SIZE} toolbar={toolbar} pager={pager} busy={pending} />
  );
}
