"use client";

import { downloadZip } from "client-zip";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { ActionDialog } from "@/components/action-dialog";
import { getFileLinks, getZipManifest, type LinksResult, type ManifestResult } from "@/lib/bulk/actions";
import { MAX_LINKS_PER_CALL } from "@/lib/bulk/links-core";

// Feature 08 AC-2 — bulk zip, built in the browser. The server lists the selection's current files once, then signs
// links in batches of ≤ 10 just before they are fetched; each file streams from Storage into a store-only zip
// (PDF/JPG don't shrink, D3). Files that fail are left out and listed with "Retry failed"; the rest still save.
// No bytes pass through our servers and nothing is logged (same as a single download).

export type ZipTarget = { id: string; docCode: string };
export type ZipFailure = { documentId: string; docCode: string; why: "not_found" | "no_file" | "failed" };
export type ZipRun = { blob: Blob | null; saved: number; total: number; failed: ZipFailure[]; cancelled: boolean } | { error: string };

export const chunk = <T,>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** "vault-documents-2026-10-02.zip" (India date; no client names — AC-2). */
export const zipFileName = (now: Date = new Date()) =>
  `vault-documents-${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now)}.zip`;

type Deps = {
  manifest: (ids: string[]) => Promise<ManifestResult>;
  links: (versionIds: string[]) => Promise<LinksResult>;
  fetchFile: (url: string, signal: AbortSignal) => Promise<Response>;
};

/** The whole zip run, with its server calls and fetch injected (unit-tested with fakes). */
export async function runZip(targets: ZipTarget[], deps: Deps, signal: AbortSignal, onProgress: (done: number, total: number) => void): Promise<ZipRun> {
  const codeOf = new Map(targets.map((t) => [t.id, t.docCode]));
  const m = await deps.manifest(targets.map((t) => t.id));
  if (!m.ok) return { error: m.error };
  const failed: ZipFailure[] = m.missing.map((x) => ({ documentId: x.documentId, docCode: codeOf.get(x.documentId) ?? "", why: x.reason }));
  const total = m.entries.length;
  let saved = 0;
  onProgress(0, total);

  async function* files() {
    for (const batch of chunk(m.ok ? m.entries : [], MAX_LINKS_PER_CALL)) {
      if (signal.aborted) return;
      const signed = await deps.links(batch.map((e) => e.versionId)).catch(() => ({ ok: false as const, error: "" }));
      const url = new Map(signed.ok ? signed.links.map((l) => [l.versionId, l.url]) : []);
      // The batch's links are used at once (they live ≤ 60 s); bodies are read in order by the zip.
      const responses = batch.map((e) => {
        const u = url.get(e.versionId);
        if (!u) return Promise.resolve(null);
        return deps.fetchFile(u, signal).then((r) => (r.ok ? r : null), () => null);
      });
      for (let i = 0; i < batch.length; i++) {
        const e = batch[i];
        const res = await responses[i];
        if (signal.aborted) return;
        if (!res) { failed.push({ documentId: e.documentId, docCode: e.docCode, why: "failed" }); continue; }
        // Read the body fully before handing it on, so a broken stream fails this file, not the whole zip.
        const blob = await res.blob().catch(() => null);
        if (!blob) { failed.push({ documentId: e.documentId, docCode: e.docCode, why: "failed" }); continue; }
        saved++;
        onProgress(saved, total);
        yield { name: e.entryName, input: blob, lastModified: new Date() };
      }
    }
  }

  const blob = await downloadZip(files()).blob();
  if (signal.aborted) return { blob: null, saved, total, failed, cancelled: true };
  return { blob: saved > 0 ? blob : null, saved, total, failed, cancelled: false };
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const deps: Deps = {
  manifest: getZipManifest,
  links: getFileLinks,
  fetchFile: (url, signal) => fetch(url, { signal, credentials: "omit", cache: "no-store" }),
};

type Phase =
  | { kind: "running"; done: number; total: number | null }
  | { kind: "done"; saved: number; failed: ZipFailure[] }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

const WHY: Record<ZipFailure["why"], string> = { not_found: "not found", no_file: "no file", failed: "couldn't download" };

/** The progress dialog. Opens running; "Retry failed" runs again for the failed documents only. */
export function ZipDownload({ targets, open, onClose }: { targets: ZipTarget[]; open: boolean; onClose: () => void }) {
  const [run, setRun] = useState<{ targets: ZipTarget[]; n: number } | null>(null);
  // Progress is stored with the run number it belongs to; a new run shows "Preparing…" until it reports.
  const [state, setState] = useState<{ n: number; phase: Phase } | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A fresh run each time the dialog opens or Retry is pressed.
  const current = open ? (run ?? { targets, n: 0 }) : null;
  const phase: Phase = current && state?.n === current.n ? state.phase : { kind: "running", done: 0, total: null };
  useEffect(() => {
    if (!current) return;
    const n = current.n;
    const ctrl = new AbortController();
    abort.current = ctrl;
    let live = true;
    const report = (p: Phase) => { if (live) setState({ n, phase: p }); };
    runZip(current.targets, deps, ctrl.signal, (done, total) => report({ kind: "running", done, total }))
      .then((r) => {
        if ("error" in r) return report({ kind: "error", message: r.error });
        if (r.cancelled) return report({ kind: "cancelled" });
        if (r.blob && live) saveBlob(r.blob, zipFileName());
        report({ kind: "done", saved: r.saved, failed: r.failed });
      })
      .catch(() => report({ kind: "error", message: "The zip couldn't be made. Please try again." }));
    return () => { live = false; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per (open, retry number)
  }, [open, current?.n]);

  const close = () => { abort.current?.abort(); setRun(null); setState(null); onClose(); };
  const retry = (failed: ZipFailure[]) =>
    setRun({ targets: failed.map((f) => ({ id: f.documentId, docCode: f.docCode })), n: (current?.n ?? 0) + 1 });

  return (
    <ActionDialog open={open} title="Download zip" onClose={close} busy={phase.kind === "running"}>
      {phase.kind === "running" && (
        <div>
          <p role="status" aria-live="polite">
            {phase.total === null ? "Preparing…" : `Downloading ${Math.min(phase.done + 1, phase.total)} of ${phase.total}…`}
          </p>
          <progress className="mt-3 h-2 w-full accent-accent" max={phase.total ?? 1} value={phase.total ? phase.done : 0}
            aria-label="Zip progress" />
          <div className="mt-5 flex justify-end"><Button variant="secondary" onClick={close}>Cancel</Button></div>
        </div>
      )}
      {phase.kind === "done" && (
        <div>
          <p role="status" aria-live="polite" className="font-medium">
            {phase.saved > 0 ? `Saved ${phase.saved} file${phase.saved === 1 ? "" : "s"}` : "No files saved"}
            {phase.failed.length > 0 && ` · ${phase.failed.length} failed`}
          </p>
          {phase.failed.length > 0 && (
            <ul aria-label="Files not in the zip" className="mt-3 max-h-48 overflow-auto text-[13.5px] text-ink-2">
              {phase.failed.map((f) => <li key={f.documentId}>{f.docCode || "A document"} — {WHY[f.why]}</li>)}
            </ul>
          )}
          {phase.failed.some((f) => f.why === "failed") && (
            <p id="zip-retry-note" className="mt-2 text-[13px] text-ink-2">Retry saves the failed files as a second zip.</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            {phase.failed.some((f) => f.why === "failed") && (
              <Button variant="secondary" aria-describedby="zip-retry-note" onClick={() => retry(phase.failed.filter((f) => f.why === "failed"))}>Retry failed</Button>
            )}
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      )}
      {phase.kind === "cancelled" && (
        <div>
          <p role="status">Cancelled. Nothing was saved.</p>
          <div className="mt-5 flex justify-end"><Button onClick={close}>Close</Button></div>
        </div>
      )}
      {phase.kind === "error" && (
        <div>
          <p role="alert" className="text-bad">{phase.message}</p>
          <div className="mt-5 flex justify-end gap-2">
            {/* The cap can't change on a retry: narrowing the selection is the only way forward. */}
            {!/^Up to 100 files/.test(phase.message) && (
              <Button variant="secondary" onClick={() => setRun({ targets: current?.targets ?? targets, n: (current?.n ?? 0) + 1 })}>Try again</Button>
            )}
            <Button onClick={close}>Close</Button>
          </div>
        </div>
      )}
    </ActionDialog>
  );
}
