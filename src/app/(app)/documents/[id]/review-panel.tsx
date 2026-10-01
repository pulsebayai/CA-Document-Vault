"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "@/components/ui";
import { Modal } from "@/components/dialog";
import { undoReview, type ReviewActionResult } from "@/lib/review/actions";
import { undoDispatchItem } from "@/lib/dispatch/actions";
import type { ReviewEvent } from "@/lib/review/queries";
import type { Packet } from "@/lib/dispatch/queries";
import { methodLabel, type ShownState } from "@/lib/documents/state";
import { ReasonForm, ReviewControls } from "../../clients/[id]/review-controls";
import { DispatchDialog } from "../../clients/[id]/dispatch-dialog";

// Feature 07 AC-13: the document page's Review panel (state, history newest first, actions incl. Undo for
// Admin/Manager; the state shown is the review state alone) and, for originals, the Dispatch panel (packet details; "Also in this packet"; Undo dispatch).

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const date = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const OUTCOME: Record<ReviewEvent["outcome"], string> = {
  reviewed: "marked it reviewed", needs_correction: "marked it as needing correction", undone: "undid the review",
  reset: "changed it — back to To review",
};
const TONE: Record<ShownState["kind"], string> = {
  archived: "text-ink-3", inbox: "text-ink-3", dispatched: "text-ok", ready: "text-accent",
  needs_correction: "text-bad", reviewed: "text-ok", to_review: "text-warn",
};

type Common = { documentId: string; clientId: string | null; label: string; canUndo: boolean };

export function ReviewPanel({ documentId, clientId, label, canUndo, state, reviewable, status, history }: Common & {
  state: ShownState; reviewable: boolean; status: string; history: ReviewEvent[];
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (r: ReviewActionResult) => { setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error }); router.refresh(); };
  const reviewNext = reviewable && (status === "received" || status === "needs_correction");
  return (
    <Card className="p-5">
      <section aria-labelledby="review-title">
        <h2 id="review-title" className="font-semibold">Review</h2>
        <p className={`mt-2 break-words font-medium ${TONE[state.kind]}`} data-testid="review-state">
          {state.text}
        </p>
        {reviewable && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {reviewNext && clientId && <ReviewControls documentId={documentId} clientId={clientId} label={label} />}
            {canUndo && status !== "received" && (
              <Modal trigger="Undo review" title={`Undo review: ${label}`} triggerVariant="button">
                {(close) => (
                  <ReasonForm intro="It goes back to To review. The history keeps what happened." submit="Undo review" close={close}
                    onSubmit={(reason) => undoReview({ id: documentId, clientId: clientId ?? undefined, reason })} onDone={done} />
                )}
              </Modal>
            )}
          </div>
        )}
        {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
        <h3 className="mt-4 text-[13px] font-medium text-ink-3">History</h3>
        {history.length === 0 ? <p className="mt-1 text-[13.5px] text-ink-2">Not reviewed yet.</p> : (
          <ol aria-label="Review history" className="mt-1 space-y-1.5 text-[13.5px]">
            {history.map((h) => (
              <li key={h.id}>
                <span className="font-medium">{h.actor}</span> {OUTCOME[h.outcome]}
                {h.reason && <span className="break-words"> — {h.reason}</span>}
                <span className="text-ink-3"> · {when.format(new Date(h.at))}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Card>
  );
}

export function DispatchPanel({ documentId, clientId, label, canUndo, packets, ready, today }: Common & {
  packets: Packet[]; ready: boolean; today: string;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const live = packets.find((p) => p.removedAt === null) ?? null;
  const earlier = packets.filter((p) => p !== live);
  return (
    <Card className="p-5">
      <section aria-labelledby="dispatch-title">
        <h2 id="dispatch-title" className="font-semibold">Dispatch</h2>
        {live ? (
          <>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px]">
              <dt className="text-[13px] text-ink-3">Dispatched</dt><dd>{date.format(new Date(`${live.dispatchedOn}T00:00:00+05:30`))}</dd>
              <dt className="text-[13px] text-ink-3">Method</dt><dd>{methodLabel(live.method)}</dd>
              {live.courierName && <><dt className="text-[13px] text-ink-3">Courier</dt><dd className="break-words">{live.courierName}</dd></>}
              {live.trackingNo && <><dt className="text-[13px] text-ink-3">Tracking</dt><dd className="break-words">{live.trackingNo}</dd></>}
              <dt className="text-[13px] text-ink-3">Recipient</dt><dd className="break-words">{live.recipientName}</dd>
              <dt className="text-[13px] text-ink-3">By</dt><dd>{live.createdBy}</dd>
            </dl>
            <PacketItems packet={live} documentId={documentId} />
            {canUndo && (
              <div className="mt-3">
                <Modal trigger="Undo dispatch" title={`Undo dispatch: ${label}`} triggerVariant="button">
                  {(close) => (
                    <ReasonForm intro="This original comes out of its packet and goes back to Ready to dispatch. The packet keeps its history." submit="Undo dispatch" close={close}
                      onSubmit={(reason) => undoDispatchItem({ documentId, clientId: clientId ?? undefined, reason })}
                      onDone={(r) => { setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error }); router.refresh(); }} />
                  )}
                </Modal>
              </div>
            )}
          </>
        ) : (
          <div className="mt-2 space-y-3">
            <p className="text-[13.5px] text-ink-2">{ready ? "Ready to dispatch — this original still needs to go back to the client." : "Not ready yet — review it first."}</p>
            {ready && clientId && <DispatchDialog clientId={clientId} documentId={documentId} label={label} today={today} />}
          </div>
        )}
        {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
        {earlier.length > 0 && (
          <>
            <h3 className="mt-4 text-[13px] font-medium text-ink-3">Removed from earlier packets</h3>
            <ul className="mt-1 space-y-1 text-[13.5px]">
              {earlier.map((p) => (
                <li key={p.id} className="break-words">
                  {date.format(new Date(`${p.dispatchedOn}T00:00:00+05:30`))} · {methodLabel(p.method)} — removed by {p.removedBy ?? "—"}{p.removedReason ? `: ${p.removedReason}` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </Card>
  );
}

function PacketItems({ packet, documentId }: { packet: Packet; documentId: string }) {
  const others = packet.items.filter((i) => i.documentId !== documentId);
  const removed = packet.items.filter((i) => i.removedAt).length;
  const summary = removed === 0 ? null : removed === packet.items.length ? "Cancelled" : `${removed} of ${packet.items.length} removed`;
  if (!others.length && !summary) return null;
  return (
    <div className="mt-3 text-[13.5px]">
      {summary && <p className="text-ink-3">Packet: {summary}</p>}
      {others.length > 0 && (
        <p className="break-words">Also in this packet:{" "}
          {others.map((i, n) => (
            <span key={i.documentId}>{n > 0 && ", "}<Link href={`/documents/${i.documentId}`} className="text-accent underline">{i.docCode}</Link>{i.removedAt ? " (removed)" : ""}</span>
          ))}
        </p>
      )}
    </div>
  );
}
