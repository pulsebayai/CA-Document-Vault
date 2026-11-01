"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { describeActivity } from "@/lib/activity-feed/catalogue";
import { whenText } from "@/lib/activity-feed/last-activity";
import { documentEvents } from "@/lib/activity-feed/actions";
import type { FeedRow } from "@/lib/activity-feed/queries";

// Feature 15 (spec AC-7, U3) — a row's "Show activity" toggle: the document's 5 latest events the viewer may see,
// fetched when first opened (not with the page) and kept while the row stays on screen, then "See all" →
// /activity?document=<id> (only the document's ID is in the URL).

type State = { status: "idle" } | { status: "loading" } | { status: "error"; error: string } | { status: "done"; rows: FeedRow[] };

export function DocumentActivityRow({ documentId, docCode }: { documentId: string; docCode: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const panelId = useId();

  const load = async () => {
    setState({ status: "loading" });
    const r = await documentEvents(documentId).catch(() => ({ ok: false as const, error: "Activity could not be loaded. Please try again." }));
    setState(r.ok ? { status: "done", rows: r.page.rows } : { status: "error", error: r.error });
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state.status === "idle") void load();
  };

  return (
    <div className="relative z-10 basis-full">
      <button type="button" aria-expanded={open} aria-controls={panelId} aria-label={`Show activity for ${docCode}`} onClick={toggle}
        className="inline-flex items-center gap-1 rounded-[6px] text-[13px] font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent">
        <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>›</span> Show activity
      </button>
      {open && (
        <div id={panelId} role="region" aria-label={`Activity panel for ${docCode}`} className="mt-1.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px]">
          {state.status === "loading" || state.status === "idle" ? (
            <p role="status" className="text-ink-2">Loading activity…</p>
          ) : state.status === "error" ? (
            <p role="alert" className="text-bad">
              {state.error}{" "}
              <button type="button" onClick={() => void load()} className="font-medium text-accent underline">Retry</button>
            </p>
          ) : state.rows.length === 0 ? (
            <p className="text-ink-2">No activity yet.</p>
          ) : (
            <>
              <ul aria-label={`Activity of ${docCode}`} className="space-y-1">
                {state.rows.map((r) => (
                  <li key={r.id} className="break-words">
                    {describeActivity(r).sentence} <span className="text-ink-3">· {whenText(r.at)}</span>
                  </li>
                ))}
              </ul>
              <Link href={`/activity?document=${documentId}`} aria-label={`See all activity for ${docCode}`}
                className="mt-1.5 inline-block font-medium text-accent hover:underline">See all</Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
