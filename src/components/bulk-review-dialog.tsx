"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { ActionDialog } from "@/components/action-dialog";
import { markReviewedBulk, type BulkReviewItem } from "@/lib/bulk/actions";

// Feature 08 AC-3 — Mark reviewed on a selection: confirm (D1) → chunks of ≤ 200 with progress → result.
// The preview of what will be skipped comes from the rows on screen; the database decides for real (another user
// may have reviewed one meanwhile), and the result shows what it decided.

export type SkipReason = Exclude<BulkReviewItem["reason"], null>;
export type ReviewTarget = { id: string; docCode: string; skip: SkipReason | null };

export const SKIP_TEXT: Record<SkipReason, string> = {
  already_reviewed: "already reviewed", needs_correction: "needs correction", in_inbox: "in inbox",
  archived: "archived", not_found: "not found",
};
export const CHUNK = 200;

const docs = (n: number) => `${n} document${n === 1 ? "" : "s"}`;

/** "Mark 48 documents reviewed? 2 will be skipped (in inbox)." */
export function confirmText(targets: ReviewTarget[]): string {
  const eligible = targets.filter((t) => !t.skip).length;
  const skipped = targets.filter((t) => t.skip);
  if (eligible === 0) return `None of the ${docs(targets.length)} can be marked reviewed (${reasons(skipped)}).`;
  const tail = skipped.length ? ` ${skipped.length} will be skipped (${reasons(skipped)}).` : "";
  return `Mark ${docs(eligible)} reviewed?${tail}`;
}
function reasons(xs: ReviewTarget[]) {
  return [...new Set(xs.map((x) => SKIP_TEXT[x.skip!]))].join(", ");
}

/** "46 reviewed · 2 skipped" */
export function resultText(results: BulkReviewItem[]): string {
  const ok = results.filter((r) => r.result === "reviewed").length;
  const skipped = results.length - ok;
  return `${ok} reviewed${skipped ? ` · ${skipped} skipped` : ""}`;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; results: BulkReviewItem[]; error?: string };

export function BulkReviewDialog({ targets, open, onClose }: { targets: ReviewTarget[]; open: boolean; onClose: (changed: boolean) => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const eligible = targets.filter((t) => !t.skip);
  const codeOf = new Map(targets.map((t) => [t.id, t.docCode]));

  async function start() {
    // Skips known on screen are sent too: the server re-checks every ID and reports its own reason.
    const ids = targets.map((t) => t.id);
    const results: BulkReviewItem[] = [];
    setPhase({ kind: "running", done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i += CHUNK) {
      const r = await markReviewedBulk(ids.slice(i, i + CHUNK)).catch(() => ({ ok: false as const, error: "Couldn't reach the server. Please try again." }));
      if (!r.ok) {
        setPhase({ kind: "done", results, error: `${r.error}${results.length ? ` The first ${docs(results.length)} were handled.` : ""}` });
        router.refresh();
        return;
      }
      results.push(...r.results);
      setPhase({ kind: "running", done: results.length, total: ids.length });
    }
    setPhase({ kind: "done", results });
    router.refresh();
  }

  const close = () => {
    const changed = phase.kind === "done";
    setPhase({ kind: "confirm" });
    onClose(changed);
  };

  return (
    <ActionDialog open={open} title="Mark reviewed" onClose={close} busy={phase.kind === "running"}>
      {phase.kind === "confirm" && (
        <div>
          <p>{confirmText(targets)}</p>
          <p className="mt-2 text-[13.5px] text-ink-2">A review can be undone one document at a time, from the document page.</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button onClick={start} disabled={eligible.length === 0}>Mark {docs(eligible.length)} reviewed</Button>
          </div>
        </div>
      )}
      {phase.kind === "running" && (
        <div>
          <p role="status" aria-live="polite">Marking reviewed… {phase.done} of {phase.total}</p>
          <progress className="mt-3 h-2 w-full accent-accent" max={phase.total} value={phase.done} aria-label="Mark reviewed progress" />
        </div>
      )}
      {phase.kind === "done" && (
        <div>
          <p role="status" aria-live="polite" className="font-medium">{resultText(phase.results)}</p>
          {phase.error && <p role="alert" className="mt-2 text-bad">{phase.error}</p>}
          {phase.results.some((r) => r.result === "skipped") && (
            <ul aria-label="Skipped documents" className="mt-3 max-h-48 overflow-auto text-[13.5px] text-ink-2">
              {phase.results.filter((r) => r.result === "skipped").map((r) => (
                <li key={r.id}>{codeOf.get(r.id) ?? "A document"} — {SKIP_TEXT[r.reason!]}</li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex justify-end"><Button onClick={close}>Done</Button></div>
        </div>
      )}
    </ActionDialog>
  );
}
