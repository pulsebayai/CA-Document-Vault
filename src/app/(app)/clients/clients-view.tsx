import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, PageHeader } from "@/components/ui";
import { CLIENT_TYPE_LABEL } from "@/lib/validation/client";
import type { ClientType } from "@/lib/validation/identifiers";

/** One row of the clients list (mockup 03). */
export type ClientListItem = {
  id: string;
  code: string;
  name: string;
  clientType: ClientType;
  pan: string | null;
  inchargeName: string;
  groups: string[];
  pausedGroups: string[];
  archived: boolean;
  /** 04 AC-15: open expected items — overdue now, and due today (not On hold). */
  overdue?: number;
  dueToday?: number;
};

type Props = {
  clients: ClientListItem[];
  /** Active clients in the office (header count, "N clients"). */
  total: number;
  /** Clients matching the current search/filters (all pages). Defaults to `total`. */
  matched?: number;
  /** Search or filters are active: an empty result means "no match", not "no clients yet". */
  filtered?: boolean;
  /** Zero-based index of the first row on this page. */
  firstIndex?: number;
  toolbar?: ReactNode;
  pager?: ReactNode;
  busy?: boolean;
  /** Header buttons (Add client for Staff+). */
  actions?: ReactNode;
};

/** Presentational Clients list: data comes in as props, no fetching (keeps it unit-testable). */
export function ClientsView({ clients, total, matched = total, filtered = false, firstIndex = 0, toolbar, pager, busy = false, actions }: Props) {
  const showRange = filtered || matched > clients.length;
  return (
    <>
      <PageHeader title="Clients" subtitle={`${total} ${total === 1 ? "client" : "clients"}`} actions={actions} />
      {toolbar}
      {clients.length === 0 && !filtered ? (
        <Card className="px-6 py-12 text-center">
          <p className="font-medium">No clients yet</p>
          <p className="mt-1 text-ink-2">Add a client or import a CSV to get started.</p>
        </Card>
      ) : clients.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="font-medium">No clients match</p>
          <p className="mt-1 text-ink-2">Try a shorter search, or clear the filters.</p>
        </Card>
      ) : (
        <Card className={busy ? "opacity-60 transition-opacity" : undefined}>
          <ul aria-label="Clients" aria-busy={busy}>
            {clients.map((c) => <ClientRow key={c.id} c={c} />)}
          </ul>
          {(showRange || pager) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13.5px] text-ink-3">
              <span>{showRange && `Showing ${firstIndex + 1}–${firstIndex + clients.length} of ${matched}`}</span>
              {pager}
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function ClientRow({ c }: { c: ClientListItem }) {
  const nameId = `client-${c.id}`;
  const meta = [CLIENT_TYPE_LABEL[c.clientType], c.pan, `Incharge ${c.inchargeName}`, c.groups.length ? c.groups.join(", ") : null]
    .filter(Boolean).join(" · ");
  return (
    <li aria-labelledby={nameId} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3 last:border-0">
      <div className="min-w-0">
        <Link id={nameId} href={`/clients/${c.id}`} className={`font-medium hover:underline ${c.archived ? "text-ink-3" : ""}`}>{c.name}</Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
          <span>{meta}</span>
          {c.pausedGroups.map((g) => <Badge key={g} tone="muted">{g} paused</Badge>)}
          {c.archived && <Badge tone="warn">Archived</Badge>}
        </div>
      </div>
      <OpenText overdue={c.overdue ?? 0} dueToday={c.dueToday ?? 0} />
    </li>
  );
}

/** Mockup 03, right-hand text (04 AC-15): "2 overdue · 1 due today"; nothing when both are 0. */
export function openText(overdue: number, dueToday: number): string {
  return [overdue > 0 && `${overdue} overdue`, dueToday > 0 && `${dueToday} due today`].filter(Boolean).join(" · ");
}

function OpenText({ overdue, dueToday }: { overdue: number; dueToday: number }) {
  if (!overdue && !dueToday) return null;
  return (
    <span className="whitespace-nowrap text-[13.5px] font-medium">
      {overdue > 0 && <span className="text-bad">{overdue} overdue</span>}
      {overdue > 0 && dueToday > 0 && <span className="text-ink-3"> · </span>}
      {dueToday > 0 && <span className="text-warn">{dueToday} due today</span>}
    </span>
  );
}
