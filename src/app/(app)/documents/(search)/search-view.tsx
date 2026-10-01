"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { LoadingState, Block } from "@/components/states";
import { SEARCH_TEXT_EVENT, handOffSearchText } from "@/components/header-search";
import { documentFacets, findClients, searchDocuments } from "@/lib/search/actions";
import type { ClientHit, DocumentHit, FacetName, FacetValue, FilterOptions, PickerClient } from "@/lib/search/queries";
import { CHANNELS, RECEIVED_AS } from "@/lib/validation/document";
import {
  DEFAULT_FILTERS, DOC_STATES, DOC_STATUSES, PAGE_SIZE, SEARCH_TEXT_KEY, SORTS, SUGGEST_DEBOUNCE_MS, filtersToQuery,
  isFiltered, normaliseSearchText, type DocumentFilters,
} from "@/lib/validation/document-search";

// Spec 03b AC-5…AC-9, AC-11 — the results page. Filters are the URL (router.push); the text is this tab's session
// storage (the header writes it, this page reads and writes it). Searches and facet counts are server actions (POST).

const RECEIVED_LABEL: Record<string, string> = Object.fromEntries(RECEIVED_AS.map((r) => [r.value, r.label]));
const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(CHANNELS.map((c) => [c.value, c.label]));
const STATUS_LABEL: Record<string, string> = Object.fromEntries(DOC_STATUSES.map((s) => [s.value, s.label]));
const STATE_LABEL: Record<string, string> = Object.fromEntries(DOC_STATES.map((s) => [s.value, s.label]));
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const shortDate = (iso: string) => day.format(new Date(`${iso}T00:00:00+05:30`));

// ── Search text: session storage as an external store (so it survives refresh in this tab only) ─────────────────
function subscribe(onChange: () => void) {
  window.addEventListener(SEARCH_TEXT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SEARCH_TEXT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
function readText(): string {
  try {
    return window.sessionStorage.getItem(SEARCH_TEXT_KEY) ?? "";
  } catch {
    return "";
  }
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────────────────────────────────────
export type Chip = { key: keyof DocumentFilters; label: string };

/** The active-filter chips, in filter-bar order, each named "<Filter>: <value>" (AC-6). */
export function activeChips(f: DocumentFilters, o: FilterOptions, facets: FacetValue[]): Chip[] {
  const facetLabel = (facet: FacetName, value: string) => facets.find((x) => x.facet === facet && x.value === value)?.label;
  const chips: Chip[] = [];
  const add = (key: keyof DocumentFilters, name: string, value: string | undefined | null) => {
    if (f[key] !== null && f[key] !== false) chips.push({ key, label: `${name}: ${value ?? "Unknown"}` });
  };
  add("client", "Client", o.client ? `${o.client.name} · ${o.client.code}` : null);
  add("registration", "GSTIN/TAN", o.registrations.find((r) => r.id === f.registration)?.number);
  add("group", "Group", o.groups.find((g) => g.id === f.group)?.name);
  add("type", "Type", o.types.find((t) => t.id === f.type)?.name);
  add("fy", "FY", o.fys.find((y) => y.id === f.fy)?.code);
  add("period", "Period", o.periods.find((p) => p.id === f.period)?.label);
  add("as", "Received as", f.as ? RECEIVED_LABEL[f.as] : null);
  add("channel", "Channel", f.channel ? CHANNEL_LABEL[f.channel] : null);
  add("by", "Received by", f.by ? facetLabel("received_by", f.by) : null);
  add("from", "From", f.from ? shortDate(f.from) : null);
  add("to", "To", f.to ? shortDate(f.to) : null);
  add("status", "Status", f.status ? STATUS_LABEL[f.status] : null);
  add("state", "Show", f.state ? STATE_LABEL[f.state] : null);
  if (f.archived) chips.push({ key: "archived", label: "Including archived" });
  return chips;
}

/** Removing a chip also clears the filters that depend on it (type needs group, period needs FY, GSTIN needs client). */
export function withoutFilter(f: DocumentFilters, key: keyof DocumentFilters): DocumentFilters {
  const next: DocumentFilters = { ...f, page: 1, [key]: key === "archived" ? false : null };
  if (key === "group") next.type = null;
  if (key === "fy") next.period = null;
  if (key === "client") next.registration = null;
  return next;
}

/** Row text (AC-5): what it is, whose it is, and how it came in. */
export function rowText(d: DocumentHit) {
  const what = [d.typeName ?? "No type", d.periodLabel ?? d.periodCode].filter(Boolean).join(" · ");
  const who = d.clientName ?? "Inbox";
  const file = d.fileName ?? `${RECEIVED_LABEL[d.receivedAs] ?? d.receivedAs} — no file`;
  const how = [
    d.groupName, `Received ${shortDate(d.receivedOn)}${d.receivedByName ? ` by ${d.receivedByName}` : ""}`,
    CHANNEL_LABEL[d.channel] ?? d.channel, file,
  ].filter(Boolean).join(" · ");
  return { what, who, how };
}

// ── View ──────────────────────────────────────────────────────────────────────────────────────────────────────
type Answer = { key: string; total: number; rows: DocumentHit[]; facets: FacetValue[] } | { key: string; error: string };

export function SearchView({ filters, options }: { filters: DocumentFilters; options: FilterOptions }) {
  const router = useRouter();
  const text = useSyncExternalStore(subscribe, readText, () => "");
  const query = normaliseSearchText(text);
  const filterQuery = filtersToQuery(filters);
  const key = `${filterQuery}\n${query}`;

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [nonce, setNonce] = useState(0); // "Try again"
  const [showFilters, setShowFilters] = useState(false); // phones: the filter panel is collapsed
  const request = useRef(0);
  const loadedOnce = useRef(false); // the first search runs at once; later ones wait for a typing pause

  useEffect(() => {
    const id = ++request.current;
    const input = { text: query, filters };
    const delay = loadedOnce.current ? SUGGEST_DEBOUNCE_MS : 0;
    const timer = window.setTimeout(async () => {
      const [r, f] = await Promise.all([searchDocuments(input), documentFacets(input)]).catch(() => [
        { ok: false as const, error: "Could not load documents. Please try again." },
        { ok: false as const, error: "" },
      ]);
      if (id !== request.current) return; // a newer search has started
      loadedOnce.current = true;
      if (!r.ok) setAnswer({ key, error: r.error });
      else setAnswer({ key, total: r.total, rows: r.rows, facets: f.ok ? f.facets : [] });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [key, nonce, query, filters]);

  const loading = answer?.key !== key;
  const ok = answer && "rows" in answer ? answer : null;
  const facets = useMemo(() => ok?.facets ?? [], [ok]);
  const chips = useMemo(() => activeChips(filters, options, facets), [filters, options, facets]);
  const filtered = isFiltered(filters);
  const pages = ok ? Math.max(1, Math.ceil(ok.total / PAGE_SIZE)) : 1;

  const go = (next: DocumentFilters) => {
    const q = filtersToQuery(next);
    router.push(q ? `/documents?${q}` : "/documents", { scroll: false });
  };
  const set = (patch: Partial<DocumentFilters>) => go({ ...filters, page: 1, ...patch });

  const facetOptions = (facet: FacetName, labelOf: (v: string, l: string) => string, current: string | null) => {
    const list = facets.filter((x) => x.facet === facet).map((x) => ({ value: x.value, label: `${labelOf(x.value, x.label)} (${x.n})` }));
    if (current && !list.some((x) => x.value === current)) list.unshift({ value: current, label: `${labelOf(current, current)} (0)` });
    return list;
  };

  const typesOfGroup = options.types.filter((t) => t.groupId === filters.group);
  const periodsOfFy = options.periods.filter((p) => p.fyId === filters.fy);

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Documents" subtitle={ok ? `${ok.total} ${ok.total === 1 ? "document" : "documents"}` : "Searching…"} />

      <form role="search" aria-label="Search and filter documents" className="mb-3" onSubmit={(e) => { e.preventDefault(); setNonce((n) => n + 1); }}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-[440px]">
            <svg aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            {/* No `name`: even a pre-hydration submit puts nothing in the URL (AC-11). */}
            <input type="search" aria-label="Search documents" placeholder="DOC id, file name or remark" autoComplete="off" spellCheck={false}
              value={text} onChange={(e) => handOffSearchText(e.target.value)} maxLength={300}
              className="h-10 w-full rounded-[10px] border border-line-2 bg-panel pl-9 pr-3 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
          </div>
          <Select label="Sort" value={filters.sort} onChange={(v) => set({ sort: (v || "received") as DocumentFilters["sort"] })}
            options={SORTS.map((s) => ({ value: s.value, label: `Sort: ${s.label}` }))} />
          <Button type="button" size="sm" variant="secondary" className="sm:hidden" aria-expanded={showFilters} aria-controls="document-filters"
            onClick={() => setShowFilters((s) => !s)}>
            Filters{chips.length ? ` (${chips.length})` : ""}
          </Button>
        </div>

        <div id="document-filters" className={`${showFilters ? "flex" : "hidden"} mt-3 flex-wrap items-center gap-2 sm:flex`}>
          <ClientPicker selected={options.client} includeArchived={filters.archived} onPick={(c) => set({ client: c, registration: null })} />
          {filters.client && options.registrations.length > 0 && (
            <Select label="GSTIN/TAN" value={filters.registration} onChange={(v) => set({ registration: v })}
              options={options.registrations.map((r) => ({ value: r.id, label: `${r.kind === "gstin" ? "GSTIN" : "TAN"} ${r.number}` }))} />
          )}
          <Select label="Group" value={filters.group} onChange={(v) => set({ group: v, type: null })}
            options={facetOptions("group", (v, l) => options.groups.find((g) => g.id === v)?.name ?? l, filters.group)} />
          {filters.group && (
            <Select label="Type" value={filters.type} onChange={(v) => set({ type: v })}
              options={typesOfGroup.map((t) => ({ value: t.id, label: t.name }))} />
          )}
          <Select label="FY" value={filters.fy} onChange={(v) => set({ fy: v, period: null })}
            options={options.fys.map((y) => ({ value: y.id, label: y.code }))} />
          {filters.fy && (
            <Select label="Period" value={filters.period} onChange={(v) => set({ period: v })}
              options={periodsOfFy.map((p) => ({ value: p.id, label: p.label }))} />
          )}
          <Select label="Received as" value={filters.as} onChange={(v) => set({ as: v as DocumentFilters["as"] })}
            options={facetOptions("received_as", (v) => RECEIVED_LABEL[v] ?? v, filters.as)} />
          <Select label="Channel" value={filters.channel} onChange={(v) => set({ channel: v as DocumentFilters["channel"] })}
            options={facetOptions("channel", (v) => CHANNEL_LABEL[v] ?? v, filters.channel)} />
          <Select label="Received by" value={filters.by} onChange={(v) => set({ by: v })}
            options={facetOptions("received_by", (_v, l) => l, filters.by)} />
          <DateInput label="Received from" value={filters.from} onChange={(v) => set({ from: v })} />
          <DateInput label="Received to" value={filters.to} onChange={(v) => set({ to: v })} />
          <Select label="Status" value={filters.status} onChange={(v) => set({ status: v as DocumentFilters["status"] })}
            options={facetOptions("status", (v) => STATUS_LABEL[v] ?? v, filters.status)} />
          <Select label="Show" value={filters.state} onChange={(v) => set({ state: v as DocumentFilters["state"] })}
            options={DOC_STATES.map((s) => ({ value: s.value, label: s.label }))} allLabel="Show: classified and Inbox" />
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line-2 bg-panel px-3 text-[13.5px]">
            <input type="checkbox" checked={filters.archived} onChange={(e) => set({ archived: e.target.checked })} className="h-4 w-4 accent-accent" />
            Include archived
          </label>
        </div>

        {chips.length > 0 && (
          <ul aria-label="Active filters" className="mt-3 flex flex-wrap items-center gap-2">
            {chips.map((c) => (
              <li key={c.key}>
                <button type="button" aria-label={`Remove filter ${c.label}`} onClick={() => go(withoutFilter(filters, c.key))}
                  className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[13px] text-accent hover:bg-[#dde6f6]">
                  {c.label} <span aria-hidden>✕</span>
                </button>
              </li>
            ))}
            <li><Button type="button" size="sm" variant="secondary" onClick={() => go({ ...DEFAULT_FILTERS, sort: filters.sort })}>Clear all</Button></li>
          </ul>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {loading ? "Searching…" : ok ? `${ok.total} ${ok.total === 1 ? "document" : "documents"} found` : ""}
        </p>
      </form>

      {answer && "error" in answer && answer.key === key ? (
        <Card className="px-6 py-8">
          <p role="alert" className="font-medium text-bad">{answer.error}</p>
          <Button className="mt-4" variant="secondary" onClick={() => setNonce((n) => n + 1)}>Try again</Button>
        </Card>
      ) : !ok ? (
        <LoadingState label="Loading documents">
          <Block className="h-64 rounded-xl shadow-card" />
        </LoadingState>
      ) : ok.total === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="font-medium">No documents match.</p>
          <div className="mt-4 flex justify-center gap-2">
            {filtered && <Button variant="secondary" onClick={() => go({ ...DEFAULT_FILTERS, sort: filters.sort })}>Clear filters</Button>}
            {query && <Button variant="secondary" onClick={() => handOffSearchText("")}>Clear search text</Button>}
          </div>
        </Card>
      ) : (
        <div aria-busy={loading}>
          <Card className={loading ? "opacity-60" : undefined}>
            <ul aria-label="Documents" className="divide-y divide-line">
              {ok.rows.map((d) => <ResultRow key={d.id} d={d} />)}
            </ul>
          </Card>
          {pages > 1 && (
            <nav aria-label="Pages" className="mt-4 flex items-center justify-end gap-2 text-[13.5px]">
              <Button type="button" size="sm" variant="secondary" disabled={filters.page <= 1} onClick={() => go({ ...filters, page: filters.page - 1 })}>Previous</Button>
              <span>Page {filters.page} of {pages}</span>
              <Button type="button" size="sm" variant="secondary" disabled={filters.page >= pages} onClick={() => go({ ...filters, page: filters.page + 1 })}>Next</Button>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

function ResultRow({ d }: { d: DocumentHit }) {
  const { what, who, how } = rowText(d);
  return (
    <li className="relative flex flex-wrap items-center gap-3 px-5 py-3.5 hover:bg-canvas">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">
          <Link href={`/documents/${d.id}`} className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-accent">
            <span className="text-ink-3">{d.docCode}</span> · {what}
          </Link>
          <span className="text-ink-2"> · {who}</span>
        </p>
        <p className="mt-0.5 break-words text-[13.5px] text-ink-2">{how}</p>
      </div>
      <span className="flex shrink-0 gap-1.5">
        {d.receivedAs !== "soft_copy" && <Badge tone={d.receivedAs === "original" ? "bad" : "warn"}>{RECEIVED_LABEL[d.receivedAs]}</Badge>}
        {d.archived && <Badge tone="muted">Archived</Badge>}
      </span>
    </li>
  );
}

const control = "h-9 max-w-full rounded-full border border-line-2 bg-panel px-3 text-[13.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft";

function Select({ label, value, onChange, options, allLabel }: {
  label: string; value: string | null; onChange: (v: string | null) => void;
  options: { value: string; label: string }[]; allLabel?: string;
}) {
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={control}>
      {label !== "Sort" && <option value="">{allLabel ?? `${label}: all`}</option>}
      {/* Prefixed with the filter's name so a closed select still says which filter it is (step 8 review). */}
      {options.map((o) => <option key={o.value} value={o.value}>{label === "Sort" ? o.label : `${label}: ${o.label}`}</option>)}
    </select>
  );
}

function DateInput({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <label className={`${control} flex items-center gap-2`}>
      <span className="text-ink-2">{label.replace("Received ", "")}</span>
      <input type="date" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="bg-transparent outline-none" />
    </label>
  );
}

/** Client filter: type to find (02's matching, server action), pick one. The typed text never reaches the URL. */
function ClientPicker({ selected, includeArchived, onPick }: { selected: ClientHit | null; includeArchived: boolean; onPick: (id: string) => void }) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<{ q: string; archived: boolean; clients: PickerClient[] } | null>(null);
  const request = useRef(0);
  const q = normaliseSearchText(text);

  useEffect(() => {
    const id = ++request.current;
    if (q.length < 2) return;
    const t = window.setTimeout(async () => {
      const r = await findClients(q, includeArchived).catch(() => null);
      if (id === request.current) setHits({ q, archived: includeArchived, clients: r && r.ok ? r.clients : [] });
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [q, includeArchived]);

  const list: ReactNode = q.length >= 2 && hits?.q === q && hits.archived === includeArchived && (
    <ul aria-label="Matching clients" className="absolute left-0 top-full z-20 mt-1 w-72 rounded-xl border border-line bg-panel p-1 shadow-card">
      {hits.clients.length === 0 && <li className="px-3 py-2 text-[13.5px] text-ink-2">No matching clients.</li>}
      {hits.clients.map((c) => (
        <li key={c.id}>
          <button type="button" onClick={() => { setText(""); onPick(c.id); }} className="w-full rounded-lg px-3 py-2 text-left text-[13.5px] hover:bg-canvas">
            {c.name} · {c.code}{c.archived && " · Archived"}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="relative">
      <input type="search" aria-label="Client" placeholder={selected ? `Client: ${selected.name}` : "Client: find…"} autoComplete="off"
        value={text} onChange={(e) => setText(e.target.value)} className={`${control} w-48`} />
      {list}
    </div>
  );
}
