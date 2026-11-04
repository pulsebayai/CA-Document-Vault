import { viewDocument } from "@/lib/platform/queries";
import { Badge, Card } from "@/components/ui";
import { Back, Field, NoAccess, date, dateTime, size, words } from "../../../../ui";

export const dynamic = "force-dynamic";

/** 19 (spec Y5): one document's details, versions and review history. Never a file link (no download, spec decision). */
export default async function PlatformDocumentPage({ params }: PageProps<"/platform/firms/[id]/documents/[docId]">) {
  const { id, docId } = await params;
  const r = await viewDocument(id, docId);
  if (!r.ok) return <NoAccess firmId={id} />;
  const d = r.data;
  return (
    <div>
      <Back href={`/platform/firms/${id}/documents`}>Documents</Back>
      <h2 className="mb-4 text-lg font-semibold"><span className="font-mono">{d.doc_code}</span> {d.archived && <Badge tone="muted">Archived</Badge>}</h2>
      <Card className="mb-5 p-6">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Field label="Client">{d.client_name ?? "Untagged"}</Field>
          <Field label="Type">{d.type_name}</Field>
          <Field label="Period">{d.period_code}</Field>
          <Field label="Received">{date(d.received_on)} · {words(d.received_as)}{d.returnable ? " (returnable)" : ""} · {words(d.channel)}</Field>
          <Field label="Review">{words(d.status === "received" ? "to_review" : d.status)}</Field>
          <Field label="Custody">{words(d.custody)}</Field>
          <Field label="Handed over by">{d.handed_over_name}</Field>
          <Field label="Remark">{d.remark}</Field>
        </dl>
      </Card>
      <h3 className="mb-2 font-semibold">Files</h3>
      <p className="mb-3 text-[13px] text-ink-3">Support access doesn&apos;t open or download files.</p>
      <Card className="mb-5">
        <ul>
          {d.versions.map((v) => (
            <li key={v.version_no} className="flex flex-wrap gap-x-4 border-b border-line px-5 py-3 text-[13.5px] last:border-0">
              <span className="font-medium">v{v.version_no} · {v.file_name}</span>
              <span className="text-ink-3">{size(v.size_bytes)} · {dateTime(v.uploaded_at)}{v.uploaded_by ? ` · ${v.uploaded_by}` : ""}</span>
            </li>
          ))}
          {d.versions.length === 0 && <li className="px-5 py-3 text-ink-3">No file (paper only).</li>}
        </ul>
      </Card>
      <h3 className="mb-2 font-semibold">Review history</h3>
      <Card>
        <ul>
          {d.reviews.map((v, i) => (
            <li key={i} className="border-b border-line px-5 py-3 text-[13.5px] last:border-0">
              {words(v.outcome)} · {dateTime(v.at)}{v.by ? ` · ${v.by}` : ""}{v.reason && <span className="block text-ink-2">{v.reason}</span>}
            </li>
          ))}
          {d.reviews.length === 0 && <li className="px-5 py-3 text-ink-3">Not reviewed yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
