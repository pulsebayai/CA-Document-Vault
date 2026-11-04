import Link from "next/link";
import { z } from "zod";
import { viewDocuments } from "@/lib/platform/queries";
import { Badge } from "@/components/ui";
import { DataTable, NoAccess, Pager, Td, date, pageOf, words } from "../../../ui";

export const dynamic = "force-dynamic";

/** 19 (spec Y5): the firm's documents (or one client's), newest received first. File names and sizes only: no download. */
export default async function PlatformDocumentsPage({ params, searchParams }: PageProps<"/platform/firms/[id]/documents">) {
  const { id } = await params;
  const sp = await searchParams;
  const page = pageOf(sp.page);
  const client = z.uuid().safeParse(sp.client).success ? String(sp.client) : null; // an ID only, never a name
  const r = await viewDocuments(id, client, page);
  if (!r.ok) return <NoAccess firmId={id} />;
  const total = r.data.total ?? 0;
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Documents <span className="font-normal text-ink-3">{total}{client ? " for this client" : ""}</span></h2>
      <DataTable caption="Documents" head={["DOC-ID", "Client", "Type", "Period", "Received", "Status", "File"]} empty={r.data.rows.length === 0}>
        {r.data.rows.map((d) => (
          <tr key={d.id} className="border-b border-line last:border-0">
            <Td first><Link prefetch={false} href={`/platform/firms/${id}/documents/${d.id}`} className="font-mono text-accent underline-offset-2 hover:underline">{d.doc_code}</Link></Td>
            <Td>{d.client_name ?? <span className="text-ink-3">Untagged</span>}</Td>
            <Td>{d.type_name ?? "—"}</Td><Td>{d.period_code ?? "—"}</Td>
            <Td>{date(d.received_on)} <span className="text-ink-3">{words(d.received_as)}</span></Td>
            <Td>{d.archived ? <Badge tone="muted">Archived</Badge> : words(d.status === "received" ? "to_review" : d.status)}</Td>
            <Td className="text-ink-2">{d.file_name ?? "—"}</Td>
          </tr>
        ))}
      </DataTable>
      <Pager base={`/platform/firms/${id}/documents`} page={page} hasNext={page * 20 < total} extra={client ? `&client=${client}` : ""} />
    </div>
  );
}
