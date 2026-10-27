"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge, BrandMark, Button, Card } from "@/components/ui";
import { putFile } from "@/lib/documents/upload-client";
import type { LinkCode, LinkItem, LinkPage } from "@/lib/upload-links/public";
import { GST_STATES } from "@/lib/validation/gst-states";
import { formatLabel, isPreferred } from "@/lib/validation/formats";
import { finishLinkUpload, openUploadLink, startLinkUpload } from "./actions";

// Feature 10 — the client's upload page (spec AC-6…AC-9, UX "Public page"). The token is read from the URL fragment
// in the browser and sent only in POST bodies. Shows only what link_open returns; files uploaded in this browser
// session are listed per item (nothing else about past uploads is shown).

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.xlsx,.xls,.csv,.docx";

const MESSAGES: Record<LinkCode, string> = {
  NOT_ACTIVE: "This link is no longer active.",
  ITEM_NOT_ON_LINK: "This document is no longer requested.",
  FILE_TYPE_NOT_ALLOWED: "This file type can't be sent. Please send PDF, JPG, PNG, HEIC, Excel, CSV or Word files.",
  FILE_EMPTY: "This file is empty.",
  FILE_TOO_LARGE: "Each file can be up to 25 MB.",
  CAP_REACHED: "This link has received the maximum number of files.",
  RATE_LIMITED: "Too many uploads in a short time. Please try again in a little while.",
  OBJECT_MISSING: "The upload didn't finish. Please try again.",
  UPLOAD_FAILED: "Something went wrong. Please try again.",
};

const fmtDate = (iso: string | undefined) =>
  iso ? new Date(`${iso}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";

function itemTitle(i: LinkItem): string {
  const reg = i.reg_kind === "gstin" ? ` (${(i.state_code && GST_STATES[i.state_code]) || "GST"} GSTIN)` : i.reg_kind === "tan" ? " (TAN)" : "";
  return `${i.group} · ${i.type}${reg}${i.period ? ` · ${i.period}` : ""}`;
}

type FileState = { key: string; name: string; status: "uploading" | "done" | "error"; progress: number; message?: string };

type View =
  | { state: "loading" }
  | { state: "inactive"; firm?: string }
  | { state: "error" }
  | { state: "active"; token: string; page: Extract<LinkPage, { active: true }> };

export function UploadView() {
  const [view, setView] = useState<View>({ state: "loading" });
  const [files, setFiles] = useState<Record<string, FileState[]>>({});
  const [announce, setAnnounce] = useState("");
  // 11 (spec AC-13): items whose format warning was shown in this page session ("warned" goes with each upload).
  const warnedItems = useRef<Set<string>>(new Set());

  // Resolves the page for a token; callers set the view from the result (async, never inside an effect body).
  const load = useCallback(async (token: string): Promise<View> => {
    if (!token) return { state: "inactive" };
    const r = await openUploadLink(token);
    if (!r.ok) return r.code === "NOT_ACTIVE" ? { state: "inactive" } : { state: "error" };
    return r.page.active ? { state: "active", token, page: r.page } : { state: "inactive" };
  }, []);

  useEffect(() => {
    let live = true;
    void load(window.location.hash.slice(1)).then((v) => { if (live) setView(v); });
    return () => { live = false; };
  }, [load]);

  const setFile = (item: string, key: string, patch: Partial<FileState>) =>
    setFiles((all) => ({ ...all, [item]: (all[item] ?? []).map((f) => (f.key === key ? { ...f, ...patch } : f)) }));

  async function uploadAll(token: string, item: LinkItem, list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      setFiles((all) => ({ ...all, [item.id]: [...(all[item.id] ?? []), { key, name: file.name, status: "uploading", progress: 0 }] }));
      setAnnounce(`Uploading ${file.name}`);
      const start = await startLinkUpload(token, item.id, { name: file.name, size: file.size, type: file.type });
      if (!start.ok) {
        setFile(item.id, key, { status: "error", message: start.message ?? MESSAGES[start.code] });
        setAnnounce(`${file.name}: ${start.message ?? MESSAGES[start.code]}`);
        if (start.code === "NOT_ACTIVE") { setView({ state: "inactive" }); return; }
        continue;
      }
      try {
        await putFile(start.signedUrl, file, start.contentType, (p) => setFile(item.id, key, { progress: p }));
      } catch {
        setFile(item.id, key, { status: "error", message: MESSAGES.UPLOAD_FAILED });
        setAnnounce(`${file.name}: ${MESSAGES.UPLOAD_FAILED}`);
        continue;
      }
      const done = await finishLinkUpload(token, item.id, {
        path: start.path, fileName: start.fileName, size: file.size, contentType: start.contentType, warned: warnedItems.current.has(item.id),
      });
      if (done.ok) {
        setFile(item.id, key, { status: "done", progress: 100 });
        setAnnounce(`${file.name} uploaded`);
      } else {
        setFile(item.id, key, { status: "error", message: MESSAGES[done.code] });
        setAnnounce(`${file.name}: ${MESSAGES[done.code]}`);
      }
    }
    setView(await load(token)); // refresh counts and states
  }

  return (
    <div>
      <p aria-live="polite" className="sr-only">{announce}</p>
      {view.state === "loading" && <p role="status" className="py-10 text-center text-ink-3">Opening your link…</p>}
      {view.state === "error" && (
        <Card className="p-6">
          <div role="alert">
            <h1 className="text-[20px] font-semibold">Something went wrong</h1>
            <p className="mt-2 text-ink-2">Please try opening the link again.</p>
          </div>
          <Button className="mt-4" onClick={() => window.location.reload()}>Try again</Button>
        </Card>
      )}
      {view.state === "inactive" && (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2.5"><BrandMark /></div>
          <h1 className="text-[20px] font-semibold">This link is no longer active</h1>
          <p className="mt-2 text-ink-2">Please ask the person who sent it to you for a new one.</p>
        </Card>
      )}
      {view.state === "active" && (
        <ActivePage view={view} files={files} onUpload={uploadAll} onWarned={(id, text) => { warnedItems.current.add(id); setAnnounce(text); }} />
      )}
    </div>
  );
}

function ActivePage({ view, files, onUpload, onWarned }: {
  view: Extract<View, { state: "active" }>;
  files: Record<string, FileState[]>;
  onUpload: (token: string, item: LinkItem, list: FileList | File[]) => Promise<void>;
  onWarned: (itemId: string, text: string) => void;
}) {
  const { page, token } = view;
  const full = page.files_count >= page.max_files;
  return (
    <>
      <header className="mb-5 flex items-center gap-2.5">
        <BrandMark />
        <div>
          <p className="font-semibold leading-tight">{page.firm}</p>
          <p className="text-[13px] text-ink-3">Requested by {page.requester} on {fmtDate(page.sent_on)} · open until {fmtDate(page.open_until)}</p>
        </div>
      </header>
      <h1 className="mb-1 text-[22px] font-semibold">Upload your documents</h1>
      <p className="mb-5 text-ink-2">Choose the files for each document below. You can add several files to one document.</p>
      {full && <p role="alert" className="mb-4 rounded-lg bg-warn-soft px-3 py-2 text-[13.5px] text-warn">{MESSAGES.CAP_REACHED}</p>}
      <ul className="space-y-3">
        {page.items.map((item) => (
          <li key={item.id}>
            <ItemCard item={item} files={files[item.id] ?? []} disabled={full} onFiles={(list) => onUpload(token, item, list)}
              onWarned={(text) => onWarned(item.id, text)} />
          </li>
        ))}
      </ul>
      <footer className="mt-8 border-t border-line pt-4 text-[12.5px] leading-relaxed text-ink-3">
        <p>
          {page.firm} collects these documents to provide the services you have engaged it for. Files go straight to
          the firm&apos;s private storage in India and are seen only by its staff. Questions? Reply to the message that
          brought you this link.
        </p>
      </footer>
    </>
  );
}

function ItemCard({ item, files, disabled, onFiles, onWarned }: {
  item: LinkItem; files: FileState[]; disabled: boolean; onFiles: (list: FileList | File[]) => void; onWarned: (text: string) => void;
}) {
  const inputId = useId();
  const warnId = useId();
  const input = useRef<HTMLInputElement>(null);
  const chooseAgain = useRef<HTMLButtonElement>(null);
  const busy = files.some((f) => f.status === "uploading");
  // 11 (spec AC-10): files waiting for the client's answer to the format warning. Nothing is ever refused.
  // The input stays enabled while the warning is open: "Choose another file" clicks it in the same event, before
  // React re-renders (review I-1); choosing again simply replaces the waiting files.
  const [pending, setPending] = useState<File[] | null>(null);
  const preferred = item.preferred?.length ? item.preferred : null;
  const offFormat = pending ? pending.filter((f) => !isPreferred(f.name, preferred)) : [];
  useEffect(() => { if (pending) chooseAgain.current?.focus(); }, [pending]);
  function chosen(list: FileList) {
    const all = Array.from(list);
    const off = preferred ? all.filter((f) => !isPreferred(f.name, preferred)) : [];
    if (preferred && off.length > 0) {
      setPending(all);
      // Review I-2: announced through the page's live region (the group itself isn't read out on appearing).
      onWarned(`${itemTitle(item)}: this document is preferred as ${formatLabel(preferred)}.${all.length > 1 ? ` ${off.length} of ${all.length} files are in another format.` : ""} Choose another file, or upload anyway.`);
      return;
    }
    onFiles(all);
  }
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{itemTitle(item)}</h2>
        {item.received || item.files > 0 ? <Badge tone="ok">Received{item.files > 1 ? ` · ${item.files} files` : ""}</Badge> : <Badge tone="muted">Waiting</Badge>}
      </div>
      {item.note && <p className="mt-1 text-ink-2">{item.note}</p>}
      {item.needed_by && <p className="mt-1 text-[13px] text-ink-3">Needed by {fmtDate(item.needed_by)}</p>}
      {preferred && <p className="mt-1 text-[13px] font-medium text-ink-2">{formatLabel(preferred)} preferred</p>}
      <div className="mt-3">
        <input ref={input} id={inputId} type="file" multiple accept={ACCEPT} className="sr-only" disabled={disabled || busy}
          onChange={(e) => { if (e.target.files?.length) chosen(e.target.files); e.target.value = ""; }} />
        <label htmlFor={inputId}
          className={`inline-flex min-h-[44px] items-center justify-center rounded-[9px] px-4 font-medium ${disabled || busy ? "cursor-not-allowed bg-canvas text-ink-3" : "cursor-pointer bg-accent text-white hover:bg-[#264d8f]"} focus-within:outline-2 focus-within:outline-accent`}>
          {busy ? "Uploading…" : item.received || item.files > 0 ? "Add more files" : "Upload files"}
        </label>
      </div>
      {pending && (
        <div role="group" aria-labelledby={warnId} className="mt-3 rounded-lg bg-warn-soft px-4 py-3 text-[14px] text-warn">
          <p id={warnId}>This document is preferred as {formatLabel(preferred)}. If you have it in that format, please choose that file. Otherwise you can upload this one.</p>
          {pending.length > 1 && (
            <ul className="mt-1 list-disc pl-5 text-[13.5px]">{offFormat.map((f, n) => <li key={`${f.name}-${n}`}>{f.name}</li>)}</ul>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button ref={chooseAgain} type="button" className="min-h-[44px] rounded-[9px] bg-accent px-4 font-medium text-white"
              onClick={() => { setPending(null); input.current?.focus(); input.current?.click(); }}>Choose another file</button>
            <button type="button" className="min-h-[44px] rounded-[9px] border border-line-2 bg-panel px-4 font-medium text-ink"
              onClick={() => { const list = pending; setPending(null); onFiles(list); }}>Upload anyway</button>
          </div>
        </div>
      )}
      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[13.5px]">
          {files.map((f) => (
            <li key={f.key} className="flex flex-wrap items-center gap-2">
              <span className="max-w-[60%] truncate">{f.name}</span>
              {f.status === "uploading" && <span className="text-ink-3">{f.progress}%</span>}
              {f.status === "done" && <span className="text-ok">Uploaded ✓</span>}
              {f.status === "error" && <span role="alert" className="text-bad">{f.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
