"use client";

import { useRef, useState, useTransition } from "react";
import { archiveClient, unarchiveClient, type ArchiveResult } from "@/lib/clients/actions";
import { Button } from "@/components/ui";

/** AC-11: Admin/Manager archive (confirm, optional reason) and unarchive. Archive, never delete. */
export function ArchiveControls({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ArchiveResult | null>(null);
  const [pending, start] = useTransition();

  if (archived) {
    return (
      <span className="flex items-center gap-2">
        <Button variant="secondary" disabled={pending} onClick={() => start(async () => setResult(await unarchiveClient(id)))}>
          {pending ? "Unarchiving…" : "Unarchive"}
        </Button>
        {result && !result.ok && <span role="alert" className="text-[13px] text-bad">{result.error}</span>}
      </span>
    );
  }
  return (
    <>
      <Button variant="danger" onClick={() => { setResult(null); dialog.current?.showModal(); }}>Archive</Button>
      <dialog ref={dialog} aria-labelledby="archive-title" className="m-auto w-full max-w-md rounded-xl p-0 shadow-card backdrop:bg-ink/30">
        <div className="space-y-4 p-6">
          <h2 id="archive-title" className="text-lg font-semibold">Archive {name}?</h2>
          <p className="text-[13.5px] text-ink-2">The client leaves the client list. All data is kept, and an Admin or Manager can unarchive it later.</p>
          <label className="block text-[13.5px] font-medium">Reason <span className="font-normal text-ink-3">(optional)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} rows={2}
              className="mt-1 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
          </label>
          {result && !result.ok && <p role="alert" className="text-[13.5px] text-bad">{result.error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => dialog.current?.close()}>Cancel</Button>
            <Button type="button" variant="danger" disabled={pending} onClick={() => start(async () => {
              const r = await archiveClient(id, reason);
              setResult(r);
              if (r.ok) dialog.current?.close();
            })}>{pending ? "Archiving…" : "Archive client"}</Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
