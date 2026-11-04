import Link from "next/link";
import { listFirms } from "@/lib/platform/queries";
import { Badge, PageHeader } from "@/components/ui";
import { DataTable, Td, dateTime } from "./ui";

export const dynamic = "force-dynamic";

/** 19 (spec Y7, AC-5): every firm with usage counts — no client names or other firm data. */
export default async function FirmsPage() {
  const firms = await listFirms();
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Firms" subtitle={`${firms.length} ${firms.length === 1 ? "firm" : "firms"}`}
        actions={
          <div className="flex gap-2">
            <Link href="/platform/audit" className="rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Audit log</Link>
            <Link href="/platform/firms/new" className="rounded-[9px] bg-accent px-3.5 py-2 font-medium text-white hover:bg-[#264d8f]">+ New firm</Link>
          </div>
        } />
      <DataTable caption="Firms on this platform" head={["Firm", "Status", "Staff", "Clients", "Documents", "Storage", "Last activity"]} empty={firms.length === 0}>
        {firms.map((f) => (
          <tr key={f.id} className="border-b border-line last:border-0">
            <Td first>
              <Link href={`/platform/firms/${f.id}`} className="font-medium text-accent underline-offset-2 hover:underline">{f.name}</Link>
              {f.branch && <span className="block text-[13px] text-ink-3">{f.branch}</span>}
            </Td>
            <Td>
              {f.status === "suspended" ? <Badge tone="bad">Suspended</Badge> : <Badge tone="ok">Active</Badge>}
              {f.my_access && <span className="ml-1.5"><Badge tone="accent">Access open</Badge></span>}
            </Td>
            <Td>{f.staff_active}{f.staff_invited > 0 && <span className="text-ink-3"> + {f.staff_invited} invited</span>}</Td>
            <Td>{f.clients}</Td>
            <Td>{f.documents}</Td>
            <Td>{f.storage_mb} MB</Td>
            <Td className="text-ink-2">{dateTime(f.last_activity_at)}</Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
