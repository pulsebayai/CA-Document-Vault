"use client";

import { useState } from "react";
import { getFileLink } from "@/lib/documents/actions";
import { canView } from "@/lib/validation/document";

/** 10 (D3): "until reviewed" text for a client-link file whose View is held back. */
const LINK_HINT = "Sent by the client — review before opening in the browser.";
import { Button } from "@/components/ui";

/**
 * AC-10/11/13: View (PDF and browser images, new tab) and Download of a document's current file. Each click asks
 * the server for a fresh ≤ 60 s link after an RLS lookup; links are never rendered into the page.
 */
export function FileButtons({ versionId, mimeType, docCode, viewBlocked = false }: {
  versionId: string; mimeType: string; docCode: string;
  /** 10 (D3): a client-link file not yet reviewed opens only as a download. */
  viewBlocked?: boolean;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function view() {
    setError("");
    const w = window.open("", "_blank"); // opened inside the click so popup blockers allow it
    const r = await getFileLink(versionId, "view");
    if (!r.ok) { w?.close(); setError(r.error); return; }
    if (w) { w.opener = null; w.location.href = r.url; } else window.location.href = r.url;
  }
  async function download() {
    setError(""); setBusy(true);
    const r = await getFileLink(versionId, "download");
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    window.location.href = r.url; // Content-Disposition: attachment — the page stays
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {viewBlocked && canView(mimeType) && <span className="text-[12.5px] text-ink-3">{LINK_HINT}</span>}
      {canView(mimeType) && !viewBlocked && <Button type="button" size="sm" variant="secondary" aria-label={`View ${docCode}`} onClick={() => void view()}>View</Button>}
      <Button type="button" size="sm" variant="secondary" aria-label={`Download ${docCode}`} disabled={busy} onClick={() => void download()}>Download</Button>
      {error && <span role="alert" className="text-[13px] text-bad">{error}</span>}
    </span>
  );
}
