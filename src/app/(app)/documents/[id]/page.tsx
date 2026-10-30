import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue, canUndoReview } from "@/lib/auth/roles";
import { getDocumentDetail } from "@/lib/documents/queries";
import { CHANNEL_LABELS, RECEIVED_LABEL, viewBlockedForLink } from "@/lib/validation/document";
import { Badge, Card } from "@/components/ui";
import { FormatBadge, formatDetail } from "@/components/format-badge";
import { FileButtons } from "../file-buttons";
import { ArchiveDocument, NewVersion } from "./document-controls";
import { DispatchPanel, ReviewPanel } from "./review-panel";
import { documentState, isReadyToDispatch, isReturnable, paperBadge } from "@/lib/documents/state";
import { istDate } from "@/lib/documents/period";
import { reviewHistoryFor } from "@/lib/review/queries";
import { packetsForDocument } from "@/lib/dispatch/queries";
import { NO_FILTERS } from "@/lib/activity-feed/filters";
import { loadFeed } from "@/lib/activity-feed/queries";
import { ActivityCard, CARD_LIMIT } from "./activity-card";

// Document page (spec AC-11): details, current file (View/Download), versions, activity; edit, new version,
// archive (Admin/Manager). RLS: a document the user can't see is Not Found (AC-12).

const CHANNEL_LABEL = CHANNEL_LABELS; // 10: includes "Upload link"
const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const date = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default async function DocumentPage({ params, searchParams }: PageProps<"/documents/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const saved = typeof sp.saved === "string" && /^DOC-FY\d{2}-\d{2}-\d{5,}$/.test(sp.saved) ? sp.saved : null;
  const me = await requireStaff();
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await getDocumentDetail(id);
  if (!d) notFound();
  const current = d.versions.find((v) => v.id === d.currentVersionId);
  const returnable = isReturnable(d); // 12: what 07 called an original
  const paper = paperBadge(d);
  const archived = !!d.archivedAt;
  // 07 (AC-13): review history + packets; the Review panel shows the review state alone (not the dispatch state).
  const [history, packets, feed] = await Promise.all([
    reviewHistoryFor(d.id), returnable ? packetsForDocument(d.id) : Promise.resolve([]),
    loadFeed({ ...NO_FILTERS, document: d.id }, null, CARD_LIMIT), // 08 AC-10
  ]);
  const today = istDate();
  const live = packets.find((p) => p.removedAt === null) ?? null;
  const stateInput = {
    archived, clientId: d.client?.id ?? null, docTypeId: d.docTypeId, receivedAs: d.receivedAs, returnable: d.returnable, status: d.status,
    reviewedAt: d.reviewedAt, reviewedByName: d.reviewedByName, correctionReason: d.correctionReason, correctionKind: d.correctionKind,
    dispatchedOn: live?.dispatchedOn ?? null, dispatchMethod: live?.method ?? null,
  };
  const reviewState = documentState({ ...stateInput, receivedAs: "hard_copy", returnable: false, dispatchedOn: null }, today);
  const canUndo = canManageCatalogue(me.role);
  const label = `${d.typeName ?? "Document"}${d.periodLabel ? ` · ${d.periodLabel}` : ""} (${d.docCode})`;

  return (
    <div className="mx-auto max-w-[1000px] space-y-5">
      <nav aria-label="Breadcrumb" className="text-[13.5px] text-ink-3">
        {d.client ? <Link href={`/clients/${d.client.id}?tab=documents`} className="hover:underline">{d.client.name}</Link> : <Link href="/inbox" className="hover:underline">Untagged documents</Link>}
        {" "}/ {d.docCode}
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight">{d.typeName ?? "Unclassified document"}{d.periodLabel ? ` · ${d.periodLabel}` : ""}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-ink-2">
            <span>{d.docCode}</span>
            {paper && <Badge tone={paper.tone}>{paper.label}</Badge>}
            {!d.classified && <Badge tone="warn">Untagged</Badge>}
            {d.channel === "upload_link" && <Badge tone="accent">From client link</Badge>}
            <FormatBadge preferred={d.notPreferred} />
            {archived && <Badge tone="muted">Archived</Badge>}
          </p>
          {d.notPreferred && <p className="mt-1 text-[13px] text-ink-2">{formatDetail(d.fileName, d.notPreferred)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!archived && <Link href={`/documents/${d.id}/assign`} className="inline-flex h-[30px] items-center rounded-[7px] border border-line-2 bg-panel px-2.5 text-[13px] font-medium hover:bg-canvas">{d.classified ? "Edit" : "Assign"}</Link>}
          {canManageCatalogue(me.role) && <ArchiveDocument id={d.id} docCode={d.docCode} archived={archived} />}
        </div>
      </div>

      {saved && <p role="status" className="rounded-lg bg-ok-soft px-4 py-3 text-[13.5px] text-ok"><strong className="font-semibold">{saved}</strong> saved.</p>}

      {archived && (
        <p role="status" className="rounded-lg bg-warn-soft px-4 py-3 text-[13.5px] text-warn">
          This document is archived{d.archiveReason ? <> — reason: {d.archiveReason}</> : null}. Its DOC-ID and files are kept.
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="font-semibold">Current file</h2>
            {current ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-0 break-words">{current.fileName} <span className="text-[13px] text-ink-3">· {size(current.sizeBytes)} · version {current.versionNo}</span></p>
                <FileButtons versionId={current.id} mimeType={current.mimeType} docCode={d.docCode} viewBlocked={viewBlockedForLink(d)} />
              </div>
            ) : (
              <p className="mt-2 text-[13.5px] text-ink-2">No file yet — {RECEIVED_LABEL[d.receivedAs].toLowerCase()} only.</p>
            )}
            {!archived && <div className="mt-4"><NewVersion documentId={d.id} correction={d.status === "needs_correction" ? { today } : undefined} preferred={d.appliedFormats ?? null} /></div>}
          </Card>

          <Card className="p-5">
            <h2 className="font-semibold">Versions</h2>
            {d.versions.length === 0 ? <p className="mt-2 text-[13.5px] text-ink-2">No files.</p> : (
              <ol aria-label="Versions" className="mt-2 divide-y divide-line">
                {d.versions.map((v) => (
                  <li key={v.id} className="py-2 text-[13.5px]">
                    <span className="font-medium">Version {v.versionNo}</span>{v.id === d.currentVersionId && <> <Badge tone="ok">Current</Badge></>}
                    <span className="block text-ink-2">{v.fileName} · {size(v.sizeBytes)} · {when.format(new Date(v.uploadedAt))} by {v.uploadedBy}</span>
                  </li>
                ))}
              </ol>
            )}
            {d.versions.length > 1 && <p className="mt-2 text-[13px] text-ink-3">Earlier versions are kept in the vault; only the current file can be opened here.</p>}
          </Card>
        </div>

        <div className="space-y-5">
          <ReviewPanel documentId={d.id} clientId={d.client?.id ?? null} label={label} canUndo={canUndoReview(me.role) && !archived}
            state={reviewState} reviewable={d.classified && !archived} status={d.status}
            history={history.map((h) => ({ ...h, atText: when.format(new Date(h.at)) }))} />
          {returnable && d.classified && (
            <DispatchPanel documentId={d.id} clientId={d.client?.id ?? null} clientName={d.client?.name ?? null} label={label} canUndo={canUndo && !archived}
              packets={packets} ready={isReadyToDispatch(stateInput)} today={today} />
          )}
          <Card className="p-5">
            <h2 className="font-semibold">Details</h2>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[14px]">
              <Item label="Client">{d.client ? <Link href={`/clients/${d.client.id}?tab=documents`} className="text-accent hover:underline">{d.client.name}</Link> : null}</Item>
              <Item label="Type">{d.typeName}</Item>
              <Item label="Group">{d.groupName}</Item>
              <Item label="Period">{d.periodLabel ?? (d.typeName ? "Not needed" : null)}</Item>
              <Item label="GSTIN / TAN">{d.registrationNumber}</Item>
              <Item label="Received as">{RECEIVED_LABEL[d.receivedAs]}{returnable ? " · returnable" : ""}</Item>
              {d.receivedAs !== "soft_copy" && <Item label="Handed over by">{d.handedOverName}</Item>}
              <Item label="Channel">{CHANNEL_LABEL[d.channel] ?? d.channel}</Item>
              <Item label="Received on">{date.format(new Date(`${d.receivedOn}T00:00:00+05:30`))}</Item>
              <Item label="Received by">{d.receivedBy}</Item>
              <Item label="Remark">{d.remark}</Item>
            </dl>
          </Card>
          <ActivityCard documentId={d.id} feed={feed} />
        </div>
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="break-words">{children ?? <span className="text-ink-3">—</span>}</dd>
    </>
  );
}
