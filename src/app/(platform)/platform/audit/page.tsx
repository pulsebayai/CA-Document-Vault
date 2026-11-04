import Link from "next/link";
import { auditList } from "@/lib/platform/queries";
import { PageHeader } from "@/components/ui";
import { Back, DataTable, Pager, Td, dateTime, pageOf } from "../ui";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = {
  "auth.signed_in": "Signed in", "firm.created": "Created the firm", "staff.invited": "Invited the first Admin",
  "staff.reinvited": "Sent the Admin's invite again", "firm.suspended": "Suspended the firm", "firm.reactivated": "Reactivated the firm",
  "access.opened": "Opened read access", "access.closed": "Closed read access", viewed: "Viewed",
  "admin.added": "Super admin added (operator script)", "admin.deactivated": "Super admin deactivated (operator script)",
  "admin.reactivated": "Super admin reactivated (operator script)",
};

/** 19 (spec AC-12): every super admin action, newest first, with the reason for access and suspensions. */
export default async function AuditPage({ searchParams }: PageProps<"/platform/audit">) {
  const page = pageOf((await searchParams).page);
  const { rows } = await auditList({ page });
  return (
    <div className="mx-auto max-w-[1100px]">
      <Back href="/platform">Firms</Back>
      <PageHeader title="Audit log" subtitle="Every super admin action on this platform. Kept for good: nothing here can be changed or deleted." />
      <DataTable caption="Platform audit log" head={["When", "Who", "What", "Firm", "Reason or detail"]} empty={rows.length === 0}>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-line align-top last:border-0">
            <Td first className="whitespace-nowrap text-ink-2">{dateTime(r.at)}</Td>
            <Td>{r.admin_name}</Td>
            <Td>{LABEL[r.action] ?? r.action}{r.action === "viewed" && typeof r.detail.view === "string" ? ` ${r.detail.view}` : ""}</Td>
            <Td>{r.office_id && r.office_name ? <Link href={`/platform/firms/${r.office_id}`} className="text-accent underline-offset-2 hover:underline">{r.office_name}</Link> : "—"}</Td>
            <Td className="max-w-[360px] text-ink-2">{r.reason ?? "—"}</Td>
          </tr>
        ))}
      </DataTable>
      <Pager base="/platform/audit" page={page} hasNext={rows.length === 50} />
    </div>
  );
}
