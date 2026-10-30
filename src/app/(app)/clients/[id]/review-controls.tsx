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
        {(close) => <CorrectionForm documentId={documentId} clientId={clientId} close={close} onDone={done} />}
      </Modal>
    </div>
  );
}

/** 12 (AC-21): what is wrong — the kind decides what fixes it (AC-23): a new file, or an edit of the details. */
const KINDS = [
  { value: "file", label: "Wrong file", hint: "Fixed by uploading the corrected file." },
  { value: "details", label: "Wrong details", hint: "Fixed by editing client, type, period, how or when it was received." },
] as const;

/**
 * 12 (AC-21): Needs correction asks for the kind and the reason. The reason is checked first by the server
 * (as in 07); with a reason given, a missing kind is refused here before anything is saved.
 */
function CorrectionForm({ documentId, clientId, close, onDone }: {
  documentId: string; clientId: string; close: () => void; onDone: (r: ReviewActionResult) => void;
}) {
  const [kind, setKind] = useState<"file" | "details" | "">("");
  const [kindError, setKindError] = useState("");
  const uid = useId();
  return (
    <ReasonForm
      intro="Say what is wrong. The document stays filed, but no longer counts as received until it is corrected or reviewed."
      submit="Mark needs correction" close={close}
      before={
        <fieldset aria-describedby={kindError ? `${uid}-kind` : undefined}>
          <legend className="text-[13.5px] font-medium">What is wrong?</legend>
          <div className="mt-1.5 space-y-1.5">
            {KINDS.map((k) => (
              <label key={k.value} className="flex items-start gap-2 text-[14px]">
                <input type="radio" name={`${uid}-kind`} value={k.value} checked={kind === k.value}
                  onChange={() => { setKind(k.value); setKindError(""); }} className="mt-1" />
                <span><span className="font-medium">{k.label}</span> <span className="text-ink-3">— {k.hint}</span></span>
              </label>
            ))}
          </div>
          {kindError && <p id={`${uid}-kind`} role="alert" className="mt-1 text-[13px] text-bad">{kindError}</p>}
        </fieldset>
      }
      onSubmit={async (reason) => {
        if (reason.trim() && !kind) {
          setKindError("Choose wrong file or wrong details.");
          return { ok: false, error: "", silent: true };
        }
        return markNeedsCorrection({ id: documentId, clientId, reason, ...(kind ? { kind } : {}) });
      }}
      onDone={onDone} />
  );
}

/** A required reason (1–500 characters): Needs correction, Undo review, Undo dispatch. */
export function ReasonForm({ intro, submit, close, onSubmit, onDone, label = "Reason", before }: {
  intro: string; submit: string; close: () => void; label?: string;
  /** 12: extra fields above the reason (Needs correction's kind). */
  before?: React.ReactNode;
  /** `silent`: the caller showed its own error (no reason error). */
  onSubmit: (reason: string) => Promise<{ ok: true; message: string } | { ok: false; error: string; stale?: boolean; silent?: boolean }>;
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
  const invalid = !!result && !result.ok && !result.silent;
  return (
    <form className="space-y-4" noValidate onSubmit={(e) => {
      e.preventDefault();
      start(async () => setResult(await onSubmit(reason)));
    }}>
      <p className="text-[13.5px] text-ink-2">{intro}</p>
      {before}
      <label className="block text-[13.5px] font-medium">{label}
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_REASON} rows={3} required className={inputCls}
          aria-invalid={invalid} aria-describedby={invalid ? `${uid}-reason` : undefined} />
      </label>
      {invalid && <p id={`${uid}-reason`} role="alert" className="mt-1 text-[13px] text-bad">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : submit}</Button>
      </div>
    </form>
  );
}
