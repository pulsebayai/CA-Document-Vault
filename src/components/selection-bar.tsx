"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { MAX_ZIP_FILES } from "@/lib/bulk/links-core";
import { ZipDownload } from "@/components/zip-download";
import { BulkReviewDialog, type ReviewTarget } from "@/components/bulk-review-dialog";

// Feature 08 AC-1 — select documents on a page, then act on them. Selection is per page (D2): it empties when the
// page's key (filters, page, tab) changes, so what you act on is what you see. The bar is announced (role=status)
// and sticks to the bottom of the screen; on phones the buttons wrap under the count.

const EMPTY: ReadonlySet<string> = new Set();

export function useSelection(resetKey: string) {
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: resetKey, ids: EMPTY });
  const ids = state.key === resetKey ? state.ids : EMPTY;
  const update = (fn: (s: Set<string>) => void) =>
    setState((prev) => {
      const next = new Set(prev.key === resetKey ? prev.ids : EMPTY);
      fn(next);
      return { key: resetKey, ids: next };
    });
  return {
    ids,
    toggle: (id: string) => update((s) => { if (s.has(id)) s.delete(id); else s.add(id); }),
    setAll: (all: string[], on: boolean) => update((s) => { for (const id of all) { if (on) s.add(id); else s.delete(id); } }),
    clear: () => setState({ key: resetKey, ids: EMPTY }),
  };
}

const box = "h-4 w-4 shrink-0 cursor-pointer accent-accent";

/** "Select all on this page" — checked when every row is, mixed when some are. */
export function SelectAll({ pageIds, selected, onChange }: { pageIds: string[]; selected: ReadonlySet<string>; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const n = pageIds.filter((id) => selected.has(id)).length;
  const all = pageIds.length > 0 && n === pageIds.length;
  useEffect(() => { if (ref.current) ref.current.indeterminate = n > 0 && !all; }, [n, all]);
  if (pageIds.length === 0) return null;
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13.5px] text-ink-2">
      <input ref={ref} type="checkbox" className={box} checked={all} onChange={(e) => onChange(e.target.checked)} />
      Select all on this page
    </label>
  );
}

/** A row's checkbox, labelled with its DOC-ID. Sits above a row's stretched link (relative z-10). */
export function RowCheckbox({ docCode, checked, onChange }: { docCode: string; checked: boolean; onChange: () => void }) {
  return <input type="checkbox" aria-label={`Select ${docCode}`} className={`relative z-10 ${box}`} checked={checked} onChange={onChange} />;
}

export const ZIP_CAP_TEXT = "Up to 100 files / 300 MB per zip; narrow the filter.";

/** "N selected · Download zip · Mark reviewed · Clear". `items` = the selected rows, in page order. */
export function SelectionBar({ items, onClear }: { items: ReviewTarget[]; onClear: () => void }) {
  const [dialog, setDialog] = useState<"zip" | "review" | null>(null);
  const n = items.length;
  const tooMany = n > MAX_ZIP_FILES;
  return (
    <>
      <div className={n ? "sticky bottom-3 z-30 mt-3" : "sr-only"}>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-4 py-2.5 shadow-card">
          <p role="status" aria-live="polite" className="mr-auto text-[13.5px] font-medium">{n ? `${n} selected` : ""}</p>
          {n > 0 && (
            <>
              <Button size="sm" variant="secondary" disabled={tooMany} aria-describedby={tooMany ? "zip-cap" : undefined} onClick={() => setDialog("zip")}>
                <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>
                Download zip
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDialog("review")}>
                <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m5 12 4 4 10-10" /></svg>
                Mark reviewed
              </Button>
              <Button size="sm" variant="secondary" onClick={onClear}>Clear</Button>
              {tooMany && <p id="zip-cap" className="basis-full text-[13px] text-ink-2">{ZIP_CAP_TEXT}</p>}
            </>
          )}
        </div>
      </div>
      <ZipDownload targets={items} open={dialog === "zip"} onClose={() => setDialog(null)} />
      <BulkReviewDialog targets={items} open={dialog === "review"} onClose={(changed) => { setDialog(null); if (changed) onClear(); }} />
    </>
  );
}
