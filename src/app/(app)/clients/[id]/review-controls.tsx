"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { inputCls, Modal } from "@/components/dialog";
import { markNeedsCorrection, markReviewed, type ReviewActionResult } from "@/lib/review/actions";
import { MAX_REASON } from "@/lib/validation/document";

// Feature 07 AC-1, AC-2, AC-12 (ui-reference deviation: Mark reviewed on Client › Documents rows; mockup 10 shows
// state text only). One click marks it reviewed; "Needs correction…" opens the shared Modal for the reason.
// A stale action ("someone already reviewed it") refreshes the page and says so.

export type RowMessage = { ok: boolean; text: string };

/** `onMessage`: the parent shows the result in a live region that stays mounted after the refresh (the controls
 *  themselves disappear once the row's next action changes). */
export function ReviewControls({ documentId, clientId, label, onMessage }: {
  documentId: string; clientId: string; label: string; onMessage: (m: RowMessage) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const done = (r: ReviewActionResult) => {
    onMessage(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error });
    if (r.ok || r.stale) router.refresh();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" aria-label={`Mark reviewed: ${label}`} disabled={pending}
        onClick={() => start(async () => done(await markReviewed({ id: documentId, clientId })))}>
        {pending ? "Saving…" : "Mark reviewed"}
      </Button>
      <Modal trigger="Needs correction…" title={`Needs correction: ${label}`} triggerLabel={`Needs correction: ${label}`} triggerVariant="link">
        {(close) => (
          <ReasonForm
            intro="Say what is wrong. The document stays filed, but no longer counts as received until it is corrected or reviewed."
            submit="Mark needs correction" close={close}
            onSubmit={(reason) => markNeedsCorrection({ id: documentId, clientId, reason })} onDone={done} />
        )}
      </Modal>
    </div>
  );
}

/** A required reason (1–500 characters): Needs correction, Undo review, Undo dispatch. */
export function ReasonForm({ intro, submit, close, onSubmit, onDone, label = "Reason" }: {
  intro: string; submit: string; close: () => void; label?: string;
  onSubmit: (reason: string) => Promise<{ ok: true; message: string } | { ok: false; error: string; stale?: boolean }>;
  onDone: (r: ReviewActionResult) => void;
}) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof onSubmit>> | null>(null);
  const [pending, start] = useTransition();
  const uid = useId();
  useEffect(() => {
    if (!result) return;
    if (result.ok) { onDone(result); close(); }
    else if (result.stale) { onDone({ ok: false, error: result.error, stale: true }); close(); }
  }, [result, close, onDone]);
  const invalid = !!result && !result.ok;
  return (
    <form className="space-y-4" noValidate onSubmit={(e) => {
      e.preventDefault();
      start(async () => setResult(await onSubmit(reason)));
    }}>
      <p className="text-[13.5px] text-ink-2">{intro}</p>
      <label className="block text-[13.5px] font-medium">{label}
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_REASON} rows={3} required className={inputCls}
          aria-invalid={invalid} aria-describedby={invalid ? `${uid}-reason` : undefined} />
      </label>
      {result && !result.ok && <p id={`${uid}-reason`} role="alert" className="mt-1 text-[13px] text-bad">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : submit}</Button>
      </div>
    </form>
  );
}
