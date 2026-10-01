"use client";

import Link from "next/link";
import { useEffect, useId, useState, useTransition } from "react";
import { reopenExpected, undoWaiveExpected, waiveExpected, type ExpectedActionResult } from "@/lib/expected/actions";
import { expectedTabPath } from "@/lib/expected/prefill";
import { matchesStatus, type ExpectedItem, type StatusFilter } from "@/lib/expected/shape";
import type { StateKind } from "@/lib/expected/schedule";
import { Button, Card } from "@/components/ui";
import { inputCls, Modal } from "@/components/dialog";

// Feature 04 step 5 — Client › Expected (spec AC-13, mockup 10's due/overdue rows; AC-8 Upload, AC-9 … AC-11 actions).
// The server sends every item of the client (all FYs, all statuses); FY, group and status filter here, like 03's
// Documents tab. The state is always written out ("Overdue · 3 days late"), colour only repeats it (WCAG 1.4.1).

export type ExpectedPermissions = {
  /** Upload / Reopen: anyone who can see the client, while it isn't archived. */
  canAct: boolean;
  /** Waive: Admin, Manager, Staff (not Limited) — AC-9. */
  canWaive: boolean;
  /** Undo "Not needed": Admin, Manager — AC-10. */
  canUndo: boolean;
};

type Props = {
  clientId: string;
  items: ExpectedItem[];
  fys: Array<{ id: string; code: string }>;
  currentFyId: string | null;
  perms: ExpectedPermissions;
};

const STATUS_LABEL: Record<StatusFilter, string> = { open: "Open", received: "Received", not_needed: "Not needed", all: "All" };
const TONE: Record<StateKind, string> = {
  overdue: "text-bad", due_today: "text-warn", due: "text-ink-2", on_hold: "text-ink-3", received: "text-ok", not_needed: "text-ink-3",
};
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export const itemLabel = (i: ExpectedItem) => `${i.typeName} · ${i.periodLabel}${i.registration ? ` · ${i.registration}` : ""}`;

export function uploadHref(clientId: string, i: ExpectedItem): string {
  const q = new URLSearchParams({ client: clientId, type: i.typeId, period: i.periodId });
  if (i.registrationId) q.set("registration", i.registrationId);
  q.set("from", expectedTabPath(clientId));
  return `/documents/new?${q.toString()}`;
}

export function ExpectedView({ clientId, items, fys, currentFyId, perms }: Props) {
  const [fy, setFy] = useState(currentFyId ?? fys[0]?.id ?? "");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [notice, setNotice] = useState<ExpectedActionResult | null>(null);

  const fyCode = fys.find((f) => f.id === fy)?.code ?? "";
  const groups = [...new Map(items.map((i) => [i.groupId, { id: i.groupId, name: i.groupName }])).values()];
  const shown = items.filter((i) => (!fy || i.fyId === fy) && (!group || i.groupId === group) && matchesStatus(i, status));
  const byGroup = groups.map((g) => ({ ...g, items: shown.filter((i) => i.groupId === g.id) })).filter((g) => g.items.length);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13.5px]">Financial year
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-[9px] border border-line-2 bg-panel px-2 py-1.5">
            {fys.map((f) => <option key={f.id} value={f.id}>FY {f.code}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13.5px]">Group
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded-[9px] border border-line-2 bg-panel px-2 py-1.5">
            <option value="">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13.5px]">Status
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="rounded-[9px] border border-line-2 bg-panel px-2 py-1.5">
            {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <span className="text-[13px] text-ink-3">{shown.length} item{shown.length === 1 ? "" : "s"}</span>
      </div>

      {/* One live region for every action's outcome (the row re-renders from the server after revalidatePath). */}
      <div role="status" aria-live="polite" className="empty:hidden">
        {notice?.ok && <p className="rounded-lg bg-ok-soft px-4 py-3 text-[13.5px] text-ok">{notice.message}</p>}
      </div>
      {notice && !notice.ok && <p role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{notice.error}</p>}

      {byGroup.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="font-medium">
            {status === "open" ? `Nothing outstanding for FY ${fyCode}` : `No ${STATUS_LABEL[status].toLowerCase()} items for FY ${fyCode}`}
            {group ? " in this group" : ""}
          </p>
        </Card>
      ) : (
        byGroup.map((g) => (
          <Card key={g.id}>
            <section aria-labelledby={`exp-${g.id}`}>
              <header className="flex items-center justify-between border-b border-line px-5 py-3">
                <h3 id={`exp-${g.id}`} className="font-semibold">{g.name}</h3>
                <span className="text-[13px] text-ink-3">{g.items.length} item{g.items.length === 1 ? "" : "s"}</span>
              </header>
              <ul aria-label={`${g.name} expected documents`} className="divide-y divide-line">
                {g.items.map((i) => <Row key={i.id} clientId={clientId} item={i} perms={perms} onDone={setNotice} />)}
              </ul>
            </section>
          </Card>
        ))
      )}
    </div>
  );
}

function Row({ clientId, item: i, perms, onDone }: {
  clientId: string; item: ExpectedItem; perms: ExpectedPermissions; onDone: (r: ExpectedActionResult) => void;
}) {
  const [pending, start] = useTransition();
  const [confirmReopen, setConfirmReopen] = useState(false);
  const label = itemLabel(i);
  const run = (fn: () => Promise<ExpectedActionResult>) => start(async () => { const r = await fn(); setConfirmReopen(false); onDone(r); });
  const waived = i.status === "waived";

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">{label}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[13px]">
          <span className={`break-words font-medium ${TONE[i.state.kind]}`}>{i.state.text}</span>
          {waived && <span className="text-ink-3">· {i.waivedBy}{i.waivedAt ? `, ${day.format(new Date(i.waivedAt))}` : ""}</span>}
          {i.assignedTo && <span className="text-ink-3">· {i.assignedTo}</span>}
        </p>
      </div>
      {perms.canAct && (
        <div className="flex flex-wrap items-center gap-2">
          {i.status === "pending" && (
            <Link href={uploadHref(clientId, i)} aria-label={`Upload ${label}`}
              className="inline-flex h-[30px] items-center rounded-[7px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-[#264d8f]">Upload</Link>
          )}
          {i.status === "pending" && perms.canWaive && (
            <Modal trigger="Waive" title={`Not needed for ${label}?`} triggerLabel={`Waive ${label}`} triggerVariant="button">
              {(close) => <WaiveForm clientId={clientId} item={i} close={close} onDone={onDone} />}
            </Modal>
          )}
          {i.status === "received" && !confirmReopen && (
            <Button size="sm" variant="secondary" aria-label={`Reopen ${label}`} onClick={() => setConfirmReopen(true)}>Reopen</Button>
          )}
          {i.status === "received" && confirmReopen && (
            <span className="flex flex-wrap items-center gap-2 text-[13px]">
              <span>Still waiting for more?</span>
              <Button size="sm" disabled={pending} onClick={() => run(() => reopenExpected({ id: i.id, clientId }))}>{pending ? "Reopening…" : "Reopen"}</Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirmReopen(false)}>Cancel</Button>
            </span>
          )}
          {waived && perms.canUndo && (
            <Button size="sm" variant="secondary" aria-label={`Undo not needed for ${label}`} disabled={pending}
              onClick={() => run(() => undoWaiveExpected({ id: i.id, clientId }))}>{pending ? "Undoing…" : "Undo"}</Button>
          )}
        </div>
      )}
    </li>
  );
}

function WaiveForm({ clientId, item, close, onDone }: {
  clientId: string; item: ExpectedItem; close: () => void; onDone: (r: ExpectedActionResult) => void;
}) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ExpectedActionResult | null>(null);
  const [pending, start] = useTransition();
  const uid = useId();
  useEffect(() => { if (result?.ok) { onDone(result); close(); } }, [result, close, onDone]);
  const invalid = !!result && !result.ok;
  return (
    <form className="space-y-4" noValidate onSubmit={(e) => {
      e.preventDefault();
      start(async () => setResult(await waiveExpected({ id: item.id, clientId, reason })));
    }}>
      <p className="text-[13.5px] text-ink-2">It leaves Due and Overdue, and doesn&apos;t count in the on-time figure. An Admin or Manager can undo this.</p>
      <label className="block text-[13.5px] font-medium">Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} required className={inputCls}
          aria-invalid={invalid} aria-describedby={invalid ? `${uid}-reason` : undefined} />
      </label>
      {result && !result.ok && <p id={`${uid}-reason`} role="alert" className="mt-1 text-[13px] text-bad">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Mark not needed"}</Button>
      </div>
    </form>
  );
}
