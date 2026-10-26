"use client";

import Link from "next/link";
import { useState } from "react";
import type { ClientDocument } from "@/lib/documents/queries";
import { documentState, heldDays, nextAction, type ShownStateKind } from "@/lib/documents/state";
import { Badge } from "@/components/ui";
import { FormatBadge } from "@/components/format-badge";
import { RowCheckbox } from "@/components/selection-bar";
import { FileButtons } from "../../documents/file-buttons";
import { ReviewControls, type RowMessage } from "./review-controls";
import { DispatchDialog } from "./dispatch-dialog";

// One received document on Client › Documents (mockup 10; 03 AC-10; 07 AC-11, AC-12). 07 owns this row; 06 owns
// the expected (open) rows in documents-view.tsx. Left: received / DOC-ID / badges. Right: the shown state (text,
// not colour alone), the next action, then view/download. Undo actions live on the document page.

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const TONE: Record<ShownStateKind, string> = {
  archived: "text-ink-3", inbox: "text-ink-3", dispatched: "text-ok", ready: "text-accent",
  needs_correction: "text-bad", reviewed: "text-ok", to_review: "text-warn",
};

export function DocumentRow({ d, clientId, clientName, today, selected, onToggle }: {
  d: ClientDocument; clientId: string; clientName?: string | null; today: string;
  /** 08 AC-1: bulk selection (absent = no checkbox). */
  selected?: boolean; onToggle?: () => void;
}) {
  const [msg, setMsg] = useState<RowMessage | null>(null);
  const input = { archived: false, clientId, docTypeId: d.typeName ? "filed" : null, receivedAs: d.receivedAs, status: d.status,
    reviewedAt: d.reviewedAt, reviewedByName: d.reviewedByName, correctionReason: d.correctionReason,
    dispatchedOn: d.dispatchedOn, dispatchMethod: d.dispatchMethod };
  const state = documentState(input, today);
  const held = heldDays({ ...input, receivedOn: d.receivedOn }, today);
  const action = nextAction(state);
  const label = `${d.typeName}${d.periodLabel ? ` · ${d.periodLabel}` : ""} (${d.docCode})`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
      {onToggle && <RowCheckbox docCode={d.docCode} checked={!!selected} onChange={onToggle} />}
      {/* min width: on a half-width card the actions wrap below instead of squeezing the text column */}
      <div className="min-w-[min(100%,15rem)] flex-1">
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
          {d.fromLink && <Badge tone="accent">From client link</Badge>}
          <FormatBadge preferred={d.notPreferred} />
          {held !== null && <span className="text-ink-3">· Held {held} day{held === 1 ? "" : "s"}</span>}
        </p>
        <p className={`mt-0.5 break-words text-[13px] font-medium ${TONE[state.kind]}`} data-testid="doc-state">{state.text}</p>
      </div>
      {action === "review" && <ReviewControls documentId={d.id} clientId={clientId} label={label} onMessage={setMsg} />}
      {action === "dispatch" && (
        <DispatchDialog clientId={clientId} clientName={clientName} documentId={d.id} label={label} today={today} onMessage={(text) => setMsg({ ok: true, text })} />
      )}
      {d.current && <FileButtons versionId={d.current.id} mimeType={d.current.mimeType} docCode={d.docCode}
        viewBlocked={Boolean(d.fromLink) && d.status !== "reviewed"} />}
      {/* Always mounted, so the result is announced even though the action that produced it has gone. */}
      <p role="status" aria-live="polite" className={`basis-full text-[13px] empty:hidden ${msg?.ok === false ? "text-bad" : "text-ok"}`}>{msg?.text ?? ""}</p>
    </li>
  );
}
