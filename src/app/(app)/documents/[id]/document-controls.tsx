"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { addVersionAction, archiveDocumentAction, startUpload, unarchiveDocumentAction } from "@/lib/documents/actions";
import { putFile } from "@/lib/documents/upload-client";
import { ACCEPT_ATTRIBUTE, validateFile } from "@/lib/validation/document";
import { formatLabel, isPreferred } from "@/lib/validation/formats";
import { Button } from "@/components/ui";

/**
 * AC-11: upload a new version (same rules as AC-2; it becomes current, same DOC-ID).
 * 07 AC-4: for a Needs-correction document (`correction`), it also asks when the corrected file arrived (default
 * today, India) — that date replaces received on, so metric 1 counts from when the right file came in.
 */
const noSubscribe = () => () => {};

export function NewVersion({ documentId, correction, preferred }: {
  documentId: string; correction?: { today: string };
  /** 11 (spec AC-19): the preference that applies; shown before the upload and checked after it (never blocks). */
  preferred?: string[] | null;
}) {
  const router = useRouter();
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [receivedOn, setReceivedOn] = useState(correction?.today ?? "");
  // 12 (found by a fast local run): a date typed before the page is interactive was reset to today by hydration,
  // so the corrected file kept the wrong date. The controls are disabled in server HTML and during hydration.
  const ready = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [state, setState] = useState<{ status: "idle" } | { status: "uploading"; progress: number } | { status: "error"; error: string } | { status: "done"; preferredOk: boolean }>({ status: "idle" });

  async function choose(file: File | undefined) {
    if (!file) return;
    const v = validateFile({ name: file.name, size: file.size, type: file.type });
    if (!v.data) { setState({ status: "error", error: v.error ?? "This file can't be added." }); return; }
    setState({ status: "uploading", progress: 0 });
    const ticket = await startUpload({ name: file.name, size: file.size, type: file.type, documentId });
    if (!ticket.ok) { setState({ status: "error", error: ticket.error }); return; }
    try {
      await putFile(ticket.signedUrl, file, ticket.contentType, (p) => setState({ status: "uploading", progress: p }));
    } catch {
      setState({ status: "error", error: "The upload failed. Check your connection and try again." });
      return;
    }
    const r = await addVersionAction(documentId, { path: ticket.path, size: v.data.size, mime: v.data.mime, fileName: v.data.fileName },
      correction ? receivedOn : null);
    if (!r.ok) { setState({ status: "error", error: r.error }); return; }
    setState({ status: "done", preferredOk: isPreferred(v.data.fileName, preferred ?? null) });
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div>
      {correction && (
        <label className="mb-3 block max-w-xs text-[13.5px] font-medium">Corrected file received on
          <input type="date" value={receivedOn} max={correction.today} disabled={!ready} onChange={(e) => setReceivedOn(e.target.value)}
            className="mt-1 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 text-[14px] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
          <span className="mt-1 block text-[12.5px] font-normal text-ink-3">Replaces the received-on date, and sends it back to To review.</span>
        </label>
      )}
      <div className="inline-flex rounded-[7px] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
      <label htmlFor={`${uid}-v`} className="inline-flex h-[30px] cursor-pointer items-center rounded-[7px] border border-line-2 bg-panel px-2.5 text-[13px] font-medium hover:bg-canvas">
        Upload new version
      </label>
      <input ref={input} id={`${uid}-v`} type="file" accept={ACCEPT_ATTRIBUTE} className="sr-only" disabled={!ready}
        aria-describedby={preferred ? `${uid}-pref` : undefined} onChange={(e) => void choose(e.target.files?.[0])} />
      </div>
      {preferred && <p id={`${uid}-pref`} className="mt-1 text-[12.5px] text-ink-3">{formatLabel(preferred)} preferred for this client.</p>}
      {state.status === "uploading" && <p className="mt-1 text-[13px] text-ink-2">Uploading… {state.progress}%<span role="status" className="sr-only">Uploading</span></p>}
      {state.status === "done" && (
        <p role="status" className={`mt-1 text-[13px] ${state.preferredOk ? "text-ok" : "text-warn"}`}>
          New version saved.{state.preferredOk ? "" : ` It isn't in a preferred format (${formatLabel(preferred ?? null)} preferred).`}
        </p>
      )}
      {state.status === "error" && <p role="alert" className="mt-1 text-[13px] text-bad">{state.error}</p>}
    </div>
  );
}

/** AC-11: Admin/Manager archive (reason required) and unarchive. Archived documents leave lists; nothing is deleted. */
export function ArchiveDocument({ id, docCode, archived }: { id: string; docCode: string; archived: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  if (archived) {
    return (
      <span className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(async () => {
          const r = await unarchiveDocumentAction(id);
          if (!r.ok) setError(r.error); else router.refresh();
        })}>{pending ? "Unarchiving…" : "Unarchive"}</Button>
        {error && <span role="alert" className="text-[13px] text-bad">{error}</span>}
      </span>
    );
  }
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => { setError(""); dialog.current?.showModal(); }}>Archive</Button>
      <dialog ref={dialog} aria-labelledby="doc-archive-title" className="m-auto w-full max-w-md rounded-xl p-0 shadow-card backdrop:bg-ink/30">
        <div className="space-y-4 p-6">
          <h2 id="doc-archive-title" className="text-lg font-semibold">Archive {docCode}?</h2>
          <p className="text-[13.5px] text-ink-2">It leaves Untagged documents and client lists. The DOC-ID and files are kept, and an Admin or Manager can unarchive it.</p>
          <label className="block text-[13.5px] font-medium">Reason
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} required
              className="mt-1 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
          </label>
          {error && <p role="alert" className="text-[13.5px] text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => dialog.current?.close()}>Cancel</Button>
            <Button type="button" variant="danger" disabled={pending} onClick={() => start(async () => {
              const r = await archiveDocumentAction(id, reason);
              if (!r.ok) { setError(r.error); return; }
              dialog.current?.close();
              router.refresh();
            })}>{pending ? "Archiving…" : "Archive document"}</Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
