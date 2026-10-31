"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { markCustody, undoCustody, type CustodyStep } from "@/lib/custody/actions";
import { skipLabel } from "@/lib/custody/messages";
import type { RowMessage } from "../clients/[id]/review-controls";

// Feature 13 — hard-copy custody controls (spec AC-1 … AC-4, AC-9, S3). One click moves a document on; Undo needs no
// reason. Each result is announced in the parent's live region, which stays mounted after the refresh.

const STEP_TEXT: Record<CustodyStep, string> = { in_office: "Mark in office", ready: "Ready to dispatch" };

/** Row / panel button for the next custody step. `label` names the document for screen readers. */
export function CustodyButton({ documentId, clientId, step, label, onMessage }: {
  documentId: string; clientId?: string | null; step: CustodyStep; label: string; onMessage: (m: RowMessage) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="secondary" aria-label={`${STEP_TEXT[step]}: ${label}`} disabled={pending}
      onClick={() => start(async () => {
        const r = await markCustody({ ids: [documentId], step, clientId: clientId ?? undefined });
        if (!r.ok) { onMessage({ ok: false, text: r.error }); return; }
        // A skipped single document: someone else changed it first, or it no longer qualifies (the page refreshes).
        if (r.skipped.length) onMessage({ ok: false, text: `Not changed — ${skipLabel(r.skipped[0].reason)}. The page has been refreshed.` });
        else onMessage({ ok: true, text: r.message });
        router.refresh();
      })}>
      {pending ? "Saving…" : STEP_TEXT[step]}
    </Button>
  );
}

/** "In office N days" (P1: shown only past 30 days, bad tone; 07's "Held N days" stays as it is). */
export function InOfficeBadge({ days }: { days: number | null }) {
  if (days === null || days <= 30) return null;
  return <Badge tone="bad">In office {days} days</Badge>;
}

export type CustodyPanelView = {
  step: CustodyStep | null;
  /** Server-formatted "2 Nov 2026" (no date formatting in the browser: hydration). */
  inOfficeText: string | null; inOfficeBy: string | null;
  readyText: string | null; readyBy: string | null;
  returnable: boolean;
  /** The next click (custodyAction in state.ts), or null. */
  next: CustodyStep | null;
  /** Why there is no next click, when there isn't one. */
  hint: string | null;
  canUndo: boolean;
  inOfficeDays: number | null;
};

/** Document page Custody card (spec AC-9, UX flow): the current step with who/when, the next click, and Undo. */
export function CustodyPanel({ documentId, clientId, label, view }: { documentId: string; clientId: string | null; label: string; view: CustodyPanelView }) {
  const router = useRouter();
  const [msg, setMsg] = useState<RowMessage | null>(null);
  const [pending, start] = useTransition();
  const who = (by: string | null) => (by ? ` by ${by}` : " (set when custody started)");
  const current = view.step === "ready"
    ? <>Ready to dispatch since {view.readyText}{who(view.readyBy)}</>
    : view.step === "in_office"
      ? <>Document in office since {view.inOfficeText}{who(view.inOfficeBy)}{view.returnable ? "" : " — the firm keeps it"}</>
      : <>Not in office yet</>;
  return (
    <Card className="p-5">
      <section aria-labelledby="custody-title">
        <h2 id="custody-title" className="font-semibold">Custody</h2>
        <p className="mt-2 break-words font-medium" data-testid="custody-state">{current}</p>
        {view.step === "ready" && view.inOfficeText && (
          <p className="mt-0.5 text-[13px] text-ink-3">In office since {view.inOfficeText}{who(view.inOfficeBy)}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <InOfficeBadge days={view.inOfficeDays} />
          {view.next && <CustodyButton documentId={documentId} clientId={clientId} step={view.next} label={label} onMessage={setMsg} />}
          {view.canUndo && view.step && (
            <Button size="sm" variant="secondary" disabled={pending} aria-label={`Undo ${view.step === "ready" ? "Ready to dispatch" : "Document in office"}: ${label}`}
              onClick={() => start(async () => {
                const r = await undoCustody({ id: documentId, clientId: clientId ?? undefined });
                setMsg(r.ok ? { ok: true, text: view.step === "ready" ? "Back to Document in office." : "Back to Not in office yet." } : { ok: false, text: r.error });
                router.refresh();
              })}>
              {pending ? "Saving…" : "Undo"}
            </Button>
          )}
        </div>
        {view.hint && <p className="mt-2 text-[13px] text-ink-3">{view.hint}</p>}
        <p role="status" aria-live="polite" className={`mt-2 text-[13px] empty:hidden ${msg?.ok === false ? "text-bad" : "text-ok"}`}>{msg?.text ?? ""}</p>
      </section>
    </Card>
  );
}
