import { viewExpected } from "@/lib/platform/queries";
import { Badge } from "@/components/ui";
import { Back, DataTable, NoAccess, Pager, Td, date, pageOf } from "../../../../../ui";

export const dynamic = "force-dynamic";

/** 19 (spec Y5): a client's expected documents, read-only. */
export default async function PlatformExpectedPage({ params, searchParams }: PageProps<"/platform/firms/[id]/clients/[clientId]/expected">) {
  const { id, clientId } = await params;
  const page = pageOf((await searchParams).page);
  const r = await viewExpected(id, clientId, page);
  if (!r.ok) return <NoAccess firmId={id} />;
  const total = r.data.total ?? 0;
  const tone = (s: string) => (s === "received" ? "ok" : s === "waived" ? "muted" : "warn") as "ok" | "muted" | "warn";
  return (
    <div>
      <Back href={`/platform/firms/${id}/clients/${clientId}`}>Client</Back>
      <h2 className="mb-4 text-lg font-semibold">Expected documents <span className="font-normal text-ink-3">{total}</span></h2>
      <DataTable caption="Expected documents" head={["Type", "Period", "Status", "Ask from", "Overdue from", "Received"]} empty={r.data.rows.length === 0}>
        {r.data.rows.map((e) => (
          <tr key={e.id} className="border-b border-line last:border-0">
            <Td first>{e.type_name}</Td><Td>{e.period_code}</Td>
            <Td><Badge tone={tone(e.status)}>{e.status === "waived" ? "Not needed" : e.status.replace(/^./, (x) => x.toUpperCase())}</Badge></Td>
            <Td>{date(e.ask_on)}</Td><Td>{date(e.overdue_from)}</Td><Td>{date(e.received_on)}</Td>
          </tr>
        ))}
      </DataTable>
      <Pager base={`/platform/firms/${id}/clients/${clientId}/expected`} page={page} hasNext={page * 20 < total} />
    </div>
  );
}
