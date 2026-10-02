"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, Card, PageHeader } from "@/components/ui";
import { findClients } from "@/lib/search/actions";
import type { PickerClient } from "@/lib/search/queries";
import { describeActivity, dayHeading, istDay, timeOfDay } from "@/lib/activity-feed/catalogue";
import { ACTIVITY_CATEGORIES, type ActivityCategory } from "@/lib/activity-feed/categories";
import { activityQuery, isFiltered, NO_FILTERS, type ActivityFilters } from "@/lib/activity-feed/filters";
import type { FeedOptions, FeedPage, FeedRow } from "@/lib/activity-feed/queries";
import { loadEarlier } from "@/lib/activity-feed/actions";

// Feature 08 AC-5 … AC-9 — the Activity screen (mockup 04): rows grouped by IST day, newest first, a sentence and a
// detail line per row, filters as removable chips (03b pattern), Load earlier. Filters are the URL (IDs, a
// category, dates); the client search text stays in this component and goes to the server by POST.

/** AC-9: where a row leads, if the viewer can open it (null names = not visible under RLS). */
export function rowHref(r: FeedRow, isAdmin: boolean): string | null {
  if (r.document_id) return `/documents/${r.document_id}`;
  if (r.client_id) return `/clients/${r.client_id}`;
  if (/^(doc_type|doc_group|financial_year)\./.test(r.action)) return "/settings/catalogue";
  if (isAdmin && r.action.startsWith("staff.")) return "/settings/users";
  return null;
}

/** Rows grouped under their IST day, in feed order. */
export function groupByDay(rows: FeedRow[]): Array<{ day: string; rows: FeedRow[] }> {
  const out: Array<{ day: string; rows: FeedRow[] }> = [];
  for (const r of rows) {
    const d = istDay(r.at);
    if (out.at(-1)?.day !== d) out.push({ day: d, rows: [] });
    out.at(-1)!.rows.push(r);
  }
  return out;
}

const CATEGORY_LABEL = Object.fromEntries(ACTIVITY_CATEGORIES.map((c) => [c.id, c.label])) as Record<ActivityCategory, string>;
const shortDate = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
  .format(new Date(`${iso}T00:00:00+05:30`));

type Chip = { key: keyof ActivityFilters; label: string };
export function activityChips(f: ActivityFilters, o: FeedOptions): Chip[] {
  const chips: Chip[] = [];
  if (f.staff) chips.push({ key: "staff", label: `Staff: ${o.staff.find((s) => s.id === f.staff)?.name ?? "Unknown"}` });
  if (f.client) chips.push({ key: "client", label: `Client: ${o.client ? `${o.client.name} · ${o.client.code}` : "Not available"}` });
  if (f.document) chips.push({ key: "document", label: `Document: ${o.document?.code ?? "Not available"}` });
  if (f.action) chips.push({ key: "action", label: `Action: ${CATEGORY_LABEL[f.action]}` });
  if (f.from) chips.push({ key: "from", label: `From: ${shortDate(f.from)}` });
  if (f.to) chips.push({ key: "to", label: `To: ${shortDate(f.to)}` });
  return chips;
}

export function ActivityView({ filters, options, initial, limited, isAdmin, now }: {
  filters: ActivityFilters; options: FeedOptions; initial: { ok: true; page: FeedPage } | { ok: false; error: string };
  limited: boolean; isAdmin: boolean; now: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<FeedRow[]>(initial.ok ? initial.page.rows : []);
  const [next, setNext] = useState(initial.ok ? initial.page.next : null);
  const [more, setMore] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  const go = (f: ActivityFilters) => {
    const q = activityQuery(f);
    router.push(q ? `/activity?${q}` : "/activity", { scroll: false });
  };
  const set = (patch: Partial<ActivityFilters>) => go({ ...filters, ...patch });
  const chips = activityChips(filters, options);
  const nowDate = new Date(now);

  async function earlier() {
    if (!next) return;
    setMore({ busy: true, error: "" });
    const r = await loadEarlier(activityQuery(filters), next).catch(() => ({ ok: false as const, error: "Activity could not be loaded. Please try again." }));
    if (!r.ok) return setMore({ busy: false, error: r.error });
    setRows((x) => [...x, ...r.page.rows]);
    setNext(r.page.next);
    setMore({ busy: false, error: "" });
  }

  return (
    <div className="mx-auto max-w-[815px]">
      <PageHeader title="Activity" subtitle={limited ? "Your actions and your clients, newest first" : "Everything anyone did, newest first"} />

      <div role="group" aria-label="Filter activity" className="mb-3 flex flex-wrap items-center gap-2">
        <select aria-label="Staff" value={filters.staff ?? ""} onChange={(e) => set({ staff: e.target.value || null })} className={pill}>
          <option value="">Staff</option>
          {options.staff.map((s) => <option key={s.id} value={s.id}>Staff: {s.name}</option>)}
        </select>
        <ClientPicker onPick={(id) => set({ client: id })} />
        <select aria-label="Action" value={filters.action ?? ""} onChange={(e) => set({ action: (e.target.value || null) as ActivityCategory | null })} className={pill}>
          <option value="">Action</option>
          {ACTIVITY_CATEGORIES.map((c) => <option key={c.id} value={c.id}>Action: {c.label}</option>)}
        </select>
        <label className={`${pill} flex items-center gap-2`}>
          <span className="text-ink-2">From</span>
          <input type="date" aria-label="Date from" value={filters.from ?? ""} max={filters.to ?? undefined}
            onChange={(e) => set({ from: e.target.value || null })} className="bg-transparent outline-none" />
        </label>
        <label className={`${pill} flex items-center gap-2`}>
          <span className="text-ink-2">To</span>
          <input type="date" aria-label="Date to" value={filters.to ?? ""} min={filters.from ?? undefined}
            onChange={(e) => set({ to: e.target.value || null })} className="bg-transparent outline-none" />
        </label>
      </div>
      {chips.length > 0 && (
        <ul aria-label="Active filters" className="mb-3 flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <li key={c.key}>
              <button type="button" aria-label={`Remove filter ${c.label}`} onClick={() => set({ [c.key]: null })}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[13px] text-accent hover:bg-[#dde6f6]">
                {c.label} <span aria-hidden>✕</span>
              </button>
            </li>
          ))}
          <li><Button type="button" size="sm" variant="secondary" onClick={() => go(NO_FILTERS)}>Clear all</Button></li>
        </ul>
      )}

      {!initial.ok ? (
        <Card className="px-6 py-8">
          <p role="alert" className="font-medium text-bad">{initial.error}</p>
          <Button className="mt-4" variant="secondary" onClick={() => router.refresh()}>Try again</Button>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="font-medium">{isFiltered(filters) ? "No activity matches these filters." : "No activity yet."}</p>
          {isFiltered(filters) && <Button className="mt-4" variant="secondary" onClick={() => go(NO_FILTERS)}>Clear filters</Button>}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {groupByDay(rows).map((g) => (
            <section key={g.day} aria-labelledby={`day-${g.day}`}>
              <h2 id={`day-${g.day}`} className="border-b border-line bg-canvas/60 px-5 py-2 text-[13px] font-normal text-ink-3">
                {dayHeading(g.rows[0].at, nowDate)}
              </h2>
              <ul className="divide-y divide-line border-b border-line">
                {g.rows.map((r) => <Row key={r.id} r={r} href={rowHref(r, isAdmin)} />)}
              </ul>
            </section>
          ))}
          <div className="px-5 py-3.5">
            {next ? (
              <button type="button" onClick={earlier} disabled={more.busy} className="text-[13.5px] text-ink-2 hover:text-accent hover:underline disabled:opacity-60">
                {more.busy ? "Loading…" : "Load earlier"}
              </button>
            ) : (
              <p className="text-[13.5px] text-ink-3">That&rsquo;s everything.</p>
            )}
            {more.error && <p role="alert" className="mt-1 text-[13px] text-bad">{more.error}</p>}
          </div>
        </Card>
      )}
    </div>
  );
}

function Row({ r, href }: { r: FeedRow; href: string | null }) {
  const { sentence, detail } = describeActivity(r);
  return (
    <li className="relative flex gap-4 px-5 py-3.5 hover:bg-canvas sm:gap-8">
      <time dateTime={r.at} className="w-12 shrink-0 pt-0.5 text-[13.5px] tabular-nums text-ink-3 sm:w-20">{timeOfDay(r.at)}</time>
      <div className="min-w-0">
        <p className="break-words font-medium">
          {href ? <Link href={href} className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-accent">{sentence}</Link> : sentence}
        </p>
        {detail && <p className="mt-0.5 break-words text-[13.5px] text-ink-2">{detail}</p>}
      </div>
    </li>
  );
}

const pill = "h-9 max-w-full rounded-full border border-line-2 bg-panel px-3 text-[13.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft";

/** Client filter: type to find (02's matching via a server action, POST), pick one; only the ID reaches the URL. */
function ClientPicker({ onPick }: { onPick: (id: string) => void }) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<{ q: string; clients: PickerClient[] } | null>(null);
  const request = useRef(0);
  const q = text.trim();
  useEffect(() => {
    const id = ++request.current;
    if (q.length < 2) return;
    const t = window.setTimeout(async () => {
      const r = await findClients(q, true).catch(() => null);
      if (id === request.current) setHits({ q, clients: r && r.ok ? r.clients : [] });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);
  return (
    <div className="relative">
      <input type="search" aria-label="Client" placeholder="Client" autoComplete="off" value={text}
        onChange={(e) => setText(e.target.value)} className={`${pill} w-40`} />
      {q.length >= 2 && hits?.q === q && (
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
      )}
    </div>
  );
}
