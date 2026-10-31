"use client";

import Link from "next/link";
import { FileButtons } from "../documents/file-buttons";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { DispatchDialog } from "../clients/[id]/dispatch-dialog";
import { CustodyButton } from "../documents/custody-controls";
import { ReviewControls } from "../clients/[id]/review-controls";
import type { TodayData } from "@/lib/today/queries";
import { LogCallButton, RemindButton } from "../clients/remind-dialog";
import { MAX_PAGE, todayHref, type Scope, type Show, type TodayCard } from "@/lib/today/shape";

// Today (mockup 01, spec 06 AC-1…AC-5). Counts are buttons with a pressed state that filter the cards
// (click again to clear); the scope toggle is a pressed-state pair. Both live in the URL as enums only.
// Each expected row: Remind (AC-7) · Log call (AC-11) · Upload (04's pre-filled Add document).
// Document rows (step 9, 07's states): To review → Mark reviewed / Needs correction; Ready to dispatch → Mark
// dispatched — 07's own controls, so the rules and messages are 07's.

const LONG_DATE = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function TodayView({ data, inbox, scope, show, page, dsc }: {
  data: TodayData; inbox: number; scope: Scope; show: Show | null; page: number;
  /** 14 AC-11 (T2): the "DSC expiring" section, built from its own call (dsc_due), shown above the client cards. */
  dsc?: ReactNode;
}) {
  const router = useRouter();
  const go = (s: Scope, f: Show | null) => router.push(todayHref(s, f));
  // 07's row actions (Mark reviewed / dispatched) report here; this region stays mounted after the refresh.
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const subtitle = `${LONG_DATE.format(new Date(`${data.today}T00:00:00Z`))} · ${data.clients === 0 && !show ? "nothing outstanding"
    : `${data.clients} ${data.clients === 1 ? "client needs" : "clients need"} something`}`;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight">Today</h1>
          <p className="mt-1 text-ink-3">{subtitle}</p>
        </div>
        <div role="group" aria-label="Whose clients" className="inline-flex rounded-[10px] border border-line bg-panel p-1">
          {(["mine", "everyone"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => go(s, show)}
              className={`rounded-[7px] px-3 py-1.5 text-[13.5px] ${scope === s ? "bg-ink font-medium text-white" : "text-ink-2 hover:text-ink"}`}>
              {s === "mine" ? "My clients" : "Everyone"}
            </button>
          ))}
        </div>
      </div>

      <div role="group" aria-label="Counts — choose one to show only those" className="mb-6 flex flex-wrap gap-3">
        <Count n={data.counts.overdue} label="Overdue" tone="text-bad" pressed={show === "overdue"}
          onClick={() => go(scope, show === "overdue" ? null : "overdue")} />
        <Count n={data.counts.dueWeek} label="Due this week" tone="text-warn" pressed={show === "due_week"}
          onClick={() => go(scope, show === "due_week" ? null : "due_week")} />
        <Count n={data.counts.toReview} label="To review" tone="text-ink" pressed={show === "to_review"}
          onClick={() => go(scope, show === "to_review" ? null : "to_review")} />
        <Count n={data.counts.ready} label="Ready to dispatch" tone="text-ink" pressed={show === "ready"}
          onClick={() => go(scope, show === "ready" ? null : "ready")} />
        {/* 10 AC-17: open requested (ad-hoc) documents in scope; dated ones are rows, the rest only counted (D7). */}
        <Count n={data.counts.requested ?? 0} label="Requested" tone="text-ink" pressed={show === "requested"}
          onClick={() => go(scope, show === "requested" ? null : "requested")} />
        {/* 13 (AC-11, S4): hard copies to place, and returnable ones in office over 30 days. Their rows come only when
            the count is chosen (Sidambara 2026-10-31); the default list stays To review + Ready to dispatch. */}
        {data.counts.toPlace !== undefined && (
          <Count n={data.counts.toPlace} label="To place in office" tone="text-ink" pressed={show === "to_place"}
            onClick={() => go(scope, show === "to_place" ? null : "to_place")} />
        )}
        {data.counts.held !== undefined && (
          <Count n={data.counts.held} label="In office > 30 days" tone="text-bad" pressed={show === "held"}
            onClick={() => go(scope, show === "held" ? null : "held")} />
        )}
        <Link href="/inbox" className="flex items-baseline gap-2 rounded-xl bg-panel px-4 py-3 shadow-card hover:bg-canvas">
          <span className="text-[22px] font-semibold">{inbox}</span>{" "}<span className="text-[13.5px] text-ink-2">Untagged</span>
        </Link>
        {/* 13 (AC-13): the desk's way in. */}
        <Link href="/documents/receipt" className="flex items-center rounded-xl bg-panel px-4 py-3 text-[13.5px] font-medium text-accent shadow-card hover:bg-canvas">Log receipt</Link>
      </div>

      {(data.counts.requestedLater ?? 0) > 0 && (show === "requested" || show === null) && (
        <p className="mb-4 text-[13.5px] text-ink-2">
          {data.counts.requestedLater} requested {data.counts.requestedLater === 1 ? "document has" : "documents have"} no needed-by date in the next 7 days — see each client&apos;s Requested tab.
        </p>
      )}

      {dsc}

      <div role="status" aria-live="polite" className="empty:hidden">
        {message && <p className={`mb-4 rounded-lg px-4 py-3 text-[13.5px] ${message.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{message.text}</p>}
      </div>

      {data.cards.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="font-medium">{show ? "Nothing in this list" : scope === "mine" ? "Nothing needs you today" : "Nothing outstanding"}</p>
          {show && <button type="button" onClick={() => go(scope, null)} className="mt-2 text-[13.5px] font-medium text-accent hover:underline">Show everything</button>}
        </Card>
      ) : (
        <ul className="grid gap-5 lg:grid-cols-2" aria-label="Clients that need something">
          {data.cards.map((c) => <ClientCard key={c.clientId} card={c} today={data.today} onMessage={setMessage} />)}
        </ul>
      )}

      {/* Review N-4: "Show more" stops at the last page the URL accepts (34 pages × 30 cards). */}
      {data.hasMore && page < MAX_PAGE && (
        <div className="mt-6 text-center">
          <Link href={todayHref(scope, show, page + 1)} scroll={false}
            className="inline-flex rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Show more</Link>
        </div>
      )}
    </div>
  );
}

function Count({ n, label, tone, pressed, onClick }: { n: number; label: string; tone: string; pressed: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}
      className={`flex items-baseline gap-2 rounded-xl px-4 py-3 shadow-card ${pressed ? "bg-ink text-white" : "bg-panel hover:bg-canvas"}`}>
      <span className={`text-[22px] font-semibold ${pressed ? "" : tone}`}>{n}</span>{" "}
      <span className={`text-[13.5px] ${pressed ? "" : "text-ink-2"}`}>{label}</span>
    </button>
  );
}

function ClientCard({ card: c, today, onMessage }: { card: TodayCard; today: string; onMessage: (m: { ok: boolean; text: string }) => void }) {
  return (
    <li>
      <Card className="h-full overflow-hidden">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-canvas text-xs font-semibold text-ink-2">{c.initials}</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold"><Link href={`/clients/${c.clientId}`} className="text-accent hover:underline">{c.name}</Link></h2>
            {c.people && <p className="text-[13px] text-ink-3">{c.people}</p>}
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${c.badgeTone === "late" ? "bg-bad-soft text-bad" : c.badgeTone === "due" ? "bg-warn-soft text-warn" : "bg-canvas text-ink-2"}`}>{c.badge}</span>
        </div>
        <ul aria-label={`Open documents for ${c.name}`}>
          {c.rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1 basis-56">
                <p className="break-words">{r.title}</p>
                <p className="mt-0.5 text-[13px] text-ink-3">{r.detail}</p>
              </div>
              <span className={`text-[13px] ${r.labelTone === "late" ? "text-bad" : r.labelTone === "due" ? "text-warn" : "text-ink-2"}`}>{r.label}</span>
              <span className="flex flex-wrap gap-2">
                <RemindButton clientId={c.clientId} clientName={c.name} />
                <LogCallButton clientId={c.clientId} clientName={c.name} />
                {r.uploadHref && (
                  <Link href={r.uploadHref} aria-label={`Upload ${r.title}`}
                    className="inline-flex h-[30px] items-center rounded-[7px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-[#264d8f]">Upload</Link>
                )}
              </span>
            </li>
          ))}
          {(c.asks ?? []).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1 basis-56">
                <p className="break-words">{a.title}</p>
                <p className="mt-0.5 break-words text-[13px] text-ink-3">{a.detail}</p>
              </div>
              <span className={`text-[13px] ${a.labelTone === "late" ? "text-bad" : "text-warn"}`}>{a.label}</span>
              <span className="flex flex-wrap gap-2">
                <Link href={`/clients/${c.clientId}?tab=requested`} aria-label={`Open requested documents of ${c.name}`}
                  className="inline-flex h-[30px] items-center rounded-[7px] border border-line-2 bg-panel px-2.5 text-[13px] font-medium hover:bg-canvas">Open</Link>
                {a.uploadHref && (
                  <Link href={a.uploadHref} aria-label={`Upload ${a.title}`}
                    className="inline-flex h-[30px] items-center rounded-[7px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-[#264d8f]">Upload</Link>
                )}
              </span>
            </li>
          ))}
          {c.docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1 basis-56">
                <p className="break-words">
                  {d.title}{" "}
                  <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[12px] text-ink-2">{d.docCode}</span>
                  {d.original && <>{" "}<span className="rounded-full bg-bad-soft px-2 py-0.5 text-[12px] font-medium text-bad">Returnable</span></>}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-3">{d.detail}</p>
              </div>
              <span className={`text-[13px] ${d.kind === "ready" ? "text-warn" : d.kind === "held" ? "text-bad" : "text-ink-2"}`}>{d.label}</span>
              {d.kind === "to_review" && (d.file ? <FileButtons versionId={d.file.versionId} mimeType={d.file.mimeType} docCode={d.docCode} viewBlocked={d.file.viewBlocked} />
                : d.file === null ? <span className="text-[13px] text-ink-3">No file yet</span> : null)}
              {d.kind === "to_review"
                ? <ReviewControls documentId={d.id} clientId={c.clientId} label={`${d.docCode} ${d.title}`} onMessage={onMessage} />
                : d.kind === "to_place" // 13
                  ? <CustodyButton documentId={d.id} clientId={c.clientId} step="in_office" label={`${d.docCode} ${d.title}`} onMessage={onMessage} />
                  : d.kind === "held" // 13: in office or ready — the document page has its next step
                    ? <Link href={`/documents/${d.id}`} aria-label={`Open ${d.docCode}`}
                        className="inline-flex h-[30px] items-center rounded-[7px] border border-line-2 bg-panel px-2.5 text-[13px] font-medium hover:bg-canvas">Open</Link>
                    : <DispatchDialog clientId={c.clientId} clientName={c.name} documentId={d.id} label={`${d.docCode} ${d.title}`} today={today}
                        onMessage={(text) => onMessage({ ok: true, text })} />}
            </li>
          ))}
        </ul>
      </Card>
    </li>
  );
}
