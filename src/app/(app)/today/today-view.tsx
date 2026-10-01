"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "@/components/ui";
import { DispatchDialog } from "../clients/[id]/dispatch-dialog";
import { ReviewControls } from "../clients/[id]/review-controls";
import type { TodayData } from "@/lib/today/queries";
import { LogCallButton, RemindButton } from "../clients/remind-dialog";
import { todayHref, type Scope, type Show, type TodayCard } from "@/lib/today/shape";

// Today (mockup 01, spec 06 AC-1…AC-5). Counts are buttons with a pressed state that filter the cards
// (click again to clear); the scope toggle is a pressed-state pair. Both live in the URL as enums only.
// Each expected row: Remind (AC-7) · Log call (AC-11) · Upload (04's pre-filled Add document).
// Document rows (step 9, 07's states): To review → Mark reviewed / Needs correction; Ready to dispatch → Mark
// dispatched — 07's own controls, so the rules and messages are 07's.

const LONG_DATE = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function TodayView({ data, inbox, scope, show, page }: {
  data: TodayData; inbox: number; scope: Scope; show: Show | null; page: number;
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
        <Link href="/inbox" className="flex items-baseline gap-2 rounded-xl bg-panel px-4 py-3 shadow-card hover:bg-canvas">
          <span className="text-[22px] font-semibold">{inbox}</span>{" "}<span className="text-[13.5px] text-ink-2">In inbox</span>
        </Link>
      </div>

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

      {data.hasMore && (
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
          {c.docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1 basis-56">
                <p className="break-words">
                  {d.title}{" "}
                  <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[12px] text-ink-2">{d.docCode}</span>
                  {d.original && <>{" "}<span className="rounded-full bg-bad-soft px-2 py-0.5 text-[12px] font-medium text-bad">Original</span></>}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-3">{d.detail}</p>
              </div>
              <span className={`text-[13px] ${d.kind === "ready" ? "text-warn" : "text-ink-2"}`}>{d.label}</span>
              {d.kind === "to_review"
                ? <ReviewControls documentId={d.id} clientId={c.clientId} label={`${d.docCode} ${d.title}`} onMessage={onMessage} />
                : <DispatchDialog clientId={c.clientId} clientName={c.name} documentId={d.id} label={`${d.docCode} ${d.title}`} today={today}
                    onMessage={(text) => onMessage({ ok: true, text })} />}
            </li>
          ))}
        </ul>
      </Card>
    </li>
  );
}
