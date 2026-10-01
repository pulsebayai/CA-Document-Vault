"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { FieldError, inputCls, Modal } from "@/components/dialog";
import { createDispatch, readyOriginals, type DispatchResult } from "@/lib/dispatch/actions";
import type { ReadyOriginal } from "@/lib/dispatch/queries";
import { DISPATCH_METHODS, type DispatchMethod } from "@/lib/documents/state";
import { daysBetween } from "@/lib/expected/schedule";
import { MAX_COURIER, MAX_RECIPIENT, MAX_TRACKING } from "@/lib/validation/document";

// Feature 07 AC-8, AC-9: "Mark dispatched" opens one packet for this client. It lists every ready original of the
// client (this one ticked); date (default today, not future, not before any ticked original's received on),
// method, courier details (Courier only) and the recipient (required). If the save is refused because an original
// is no longer ready, the dialog re-lists the valid ones.

type Props = { clientId: string; documentId: string; label: string; today: string };

export function DispatchDialog({ clientId, documentId, label, today }: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Modal trigger="Mark dispatched" title="Mark originals dispatched" triggerLabel={`Mark dispatched: ${label}`} triggerVariant="button">
        {(close) => (
          <DispatchForm clientId={clientId} documentId={documentId} today={today} close={close}
            onDone={(m) => { setMsg(m); router.refresh(); }} />
        )}
      </Modal>
      {msg && <span role="status" className="text-[13px] text-ok">{msg}</span>}
    </div>
  );
}

export function DispatchForm({ clientId, documentId, today, close, onDone }: {
  clientId: string; documentId: string; today: string; close: () => void; onDone: (message: string) => void;
}) {
  const uid = useId();
  const [list, setList] = useState<ReadyOriginal[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set([documentId]));
  const [on, setOn] = useState(today);
  const [method, setMethod] = useState<DispatchMethod>("hand_delivery");
  const [courier, setCourier] = useState("");
  const [tracking, setTracking] = useState("");
  const [recipient, setRecipient] = useState("");
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    readyOriginals(clientId).then((r) => {
      if (!live) return;
      if (!r.ok) { setLoadError(r.error); return; }
      setList(r.originals);
      setTicked((t) => new Set([...t].filter((id) => r.originals.some((o) => o.id === id))));
    });
    return () => { live = false; };
  }, [clientId]);

  const fe = result && !result.ok ? result.fieldErrors : {};
  const chosen = (list ?? []).filter((o) => ticked.has(o.id));
  const latest = chosen.reduce<string | null>((m, o) => (!m || o.receivedOn > m ? o.receivedOn : m), null);
  const toggle = (id: string) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (loadError) return <p role="alert" className="text-[13.5px] text-bad">{loadError}</p>;
  if (!list) return <p role="status" className="text-[13.5px] text-ink-2">Loading originals…</p>;
  if (!list.length) {
    return (
      <div className="space-y-4">
        <p className="text-[13.5px] text-ink-2">No originals are ready to dispatch for this client.</p>
        <div className="flex justify-end"><Button type="button" variant="secondary" onClick={close}>Close</Button></div>
      </div>
    );
  }

  return (
    <form className="space-y-4" noValidate onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const r = await createDispatch({
          clientId, documentIds: [...ticked], dispatchedOn: on, method, courierName: courier, trackingNo: tracking, recipientName: recipient, latestReceivedOn: latest,
        });
        setResult(r);
        if (r.ok) { onDone(r.message); close(); return; }
        if (r.originals) {
          // AC-9: re-list the valid originals and keep only ticks that are still valid.
          const valid = new Set(r.originals.map((o) => o.id));
          setList(r.originals);
          setTicked((t) => new Set([...t].filter((id) => valid.has(id))));
        }
      });
    }}>
      <fieldset aria-describedby={fe.documentIds ? `${uid}-docs` : undefined}>
        <legend className="mb-2 text-[13.5px] font-medium">Originals going back</legend>
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-[9px] border border-line p-2">
          {list.map((o) => (
            <li key={o.id}>
              <label className="flex items-start gap-2 rounded-md px-1 py-1 text-[13.5px] hover:bg-accent-soft">
                <input type="checkbox" className="mt-1" checked={ticked.has(o.id)} onChange={() => toggle(o.id)} />
                <span className="min-w-0 break-words">
                  {o.typeName ?? "Document"}{o.periodLabel ? ` · ${o.periodLabel}` : ""}
                  <span className="block text-[12.5px] text-ink-3">{o.docCode} · held {Math.max(daysBetween(o.receivedOn, today), 0)} days</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <FieldError id={`${uid}-docs`} message={fe.documentIds} />
      </fieldset>

      <label className="block text-[13.5px] font-medium">Date dispatched
        <input type="date" value={on} max={today} min={latest ?? undefined} onChange={(e) => setOn(e.target.value)} required className={inputCls}
          aria-invalid={!!fe.dispatchedOn} aria-describedby={fe.dispatchedOn ? `${uid}-on` : undefined} />
      </label>
      <FieldError id={`${uid}-on`} message={fe.dispatchedOn} />

      <fieldset>
        <legend className="mb-1 text-[13.5px] font-medium">Method</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {DISPATCH_METHODS.map((m) => (
            <label key={m.value} className="flex items-center gap-1.5 text-[13.5px]">
              <input type="radio" name={`${uid}-method`} value={m.value} checked={method === m.value} onChange={() => setMethod(m.value)} />{m.label}
            </label>
          ))}
        </div>
      </fieldset>

      {method === "courier" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13.5px] font-medium">Courier (optional)
            <input value={courier} onChange={(e) => setCourier(e.target.value)} maxLength={MAX_COURIER} className={inputCls}
              aria-invalid={!!fe.courierName} aria-describedby={fe.courierName ? `${uid}-courier` : undefined} />
            <FieldError id={`${uid}-courier`} message={fe.courierName} />
          </label>
          <label className="block text-[13.5px] font-medium">Tracking number (optional)
            <input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={MAX_TRACKING} className={inputCls}
              aria-invalid={!!fe.trackingNo} aria-describedby={fe.trackingNo ? `${uid}-tracking` : undefined} />
            <FieldError id={`${uid}-tracking`} message={fe.trackingNo} />
          </label>
        </div>
      )}

      <label className="block text-[13.5px] font-medium">Recipient
        <input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={MAX_RECIPIENT} required autoComplete="off" className={inputCls}
          aria-invalid={!!fe.recipientName} aria-describedby={fe.recipientName ? `${uid}-recipient` : undefined} />
      </label>
      <FieldError id={`${uid}-recipient`} message={fe.recipientName} />

      {result && !result.ok && <p role="alert" className="text-[13px] text-bad">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending || ticked.size === 0}>
          {pending ? "Saving…" : `Mark ${ticked.size} dispatched`}
        </Button>
      </div>
    </form>
  );
}
