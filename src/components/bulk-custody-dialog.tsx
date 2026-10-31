"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { ActionDialog } from "@/components/action-dialog";
import { markCustodyBulk } from "@/lib/bulk/actions";
import { skipLabel } from "@/lib/custody/messages";
import { CHUNK, type ReviewTarget } from "./bulk-review-dialog";

// Feature 13 (spec AC-9) — Mark in office / Ready to dispatch on a selection, like 08's bulk Mark reviewed: confirm →
// chunks of ≤ 200 with progress → result with each skipped DOC-ID and why. The database decides what qualifies.

export type CustodyStep = "in_office" | "ready";
const TITLE: Record<CustodyStep, string> = { in_office: "Mark in office", ready: "Ready to dispatch" };
const DONE: Record<CustodyStep, string> = { in_office: "marked in office", ready: "marked ready to dispatch" };
const docs = (n: number) => `${n} document${n === 1 ? "" : "s"}`;

export function custodyConfirmText(step: CustodyStep, n: number): string {
  return step === "in_office"
    ? `Mark ${docs(n)} in office? Only reviewed hard copies not yet in office are changed; the rest are skipped and listed.`
    : `Mark ${docs(n)} ready to dispatch? Only returnable documents already in office are changed; the rest are skipped and listed.`;
}

type Item = { id: string; done: boolean; reason: string | null };
type Phase = { kind: "confirm" } | { kind: "running"; done: number; total: number } | { kind: "done"; items: Item[]; error?: string };

export function BulkCustodyDialog({ step, targets, open, onClose }: {
  step: CustodyStep | null; targets: ReviewTarget[]; open: boolean; onClose: (changed: boolean) => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const codeOf = new Map(targets.map((t) => [t.id, t.docCode]));
  const s: CustodyStep = step ?? "in_office";

  async function start() {
    const ids = targets.map((t) => t.id);
    const items: Item[] = [];
    setPhase({ kind: "running", done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i += CHUNK) {
      const r = await markCustodyBulk(ids.slice(i, i + CHUNK), s).catch(() => ({ ok: false as const, error: "Couldn't reach the server. Please try again." }));
      if (!r.ok) {
        setPhase({ kind: "done", items, error: `${r.error}${items.length ? ` The first ${docs(items.length)} were handled.` : ""}` });
        router.refresh();
        return;
      }
      items.push(...r.done.map((id) => ({ id, done: true, reason: null })), ...r.skipped.map((x) => ({ id: x.id, done: false, reason: x.reason })));
      setPhase({ kind: "running", done: items.length, total: ids.length });
    }
    setPhase({ kind: "done", items });
    router.refresh();
  }

  const close = () => {
    const changed = phase.kind === "done";
    setPhase({ kind: "confirm" });
    onClose(changed);
  };

  const skipped = phase.kind === "done" ? phase.items.filter((x) => !x.done) : [];
  return (
    <ActionDialog open={open} title={TITLE[s]} onClose={close} busy={phase.kind === "running"}>
      {phase.kind === "confirm" && (
        <div>
          <p>{custodyConfirmText(s, targets.length)}</p>
          <p className="mt-2 text-[13.5px] text-ink-2">A step can be undone one document at a time, from the document page.</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button onClick={start}>{TITLE[s]}: {docs(targets.length)}</Button>
          </div>
        </div>
      )}
      {phase.kind === "running" && (
        <div>
          <p role="status" aria-live="polite">Working… {phase.done} of {phase.total}</p>
          <progress className="mt-3 h-2 w-full accent-accent" max={phase.total} value={phase.done} aria-label={`${TITLE[s]} progress`} />
        </div>
      )}
      {phase.kind === "done" && (
        <div>
          <p role="status" aria-live="polite" className="font-medium">
            {phase.items.filter((x) => x.done).length} {DONE[s]}{skipped.length ? ` · ${skipped.length} skipped` : ""}
          </p>
          {phase.error && <p role="alert" className="mt-2 text-bad">{phase.error}</p>}
          {skipped.length > 0 && (
            <ul aria-label="Skipped documents" className="mt-3 max-h-48 overflow-auto text-[13.5px] text-ink-2">
              {skipped.map((x) => <li key={x.id}>{codeOf.get(x.id) ?? "A document"} — {skipLabel(x.reason ?? "")}</li>)}
            </ul>
          )}
          <div className="mt-5 flex justify-end"><Button onClick={close}>Done</Button></div>
        </div>
      )}
    </ActionDialog>
  );
}
