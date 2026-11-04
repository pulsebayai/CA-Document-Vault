import Link from "next/link";
import { z } from "zod";
import { auditList, listFirms } from "@/lib/platform/queries";
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

const select = "rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft";

/** 19 (spec AC-12): every super admin action, newest first, with the reason for access and suspensions; filter by firm
 * and action (IDs and action names only in the URL). */
export default async function AuditPage({ searchParams }: PageProps<"/platform/audit">) {
  const sp = await searchParams;
  const page = pageOf(sp.page);
  const firm = z.uuid().safeParse(sp.firm).success ? String(sp.firm) : "";
  const action = typeof sp.action === "string" && sp.action in LABEL ? sp.action : "";
  const [{ rows }, firms] = await Promise.all([
    auditList({ page, ...(firm ? { office_id: firm } : {}), ...(action ? { action } : {}) }),
    listFirms(),
  ]);
  const extra = `${firm ? `&firm=${firm}` : ""}${action ? `&action=${encodeURIComponent(action)}` : ""}`;
  return (
    <div className="mx-auto max-w-[1100px]">
      <Back href="/platform">Firms</Back>
      <PageHeader title="Audit log" subtitle="Every super admin action on this platform. Kept for good: nothing here can be changed or deleted." />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-[13.5px]" aria-label="Filter the audit log">
        <label className="flex flex-col gap-1">Firm
          <select name="firm" defaultValue={firm} className={select}>
            <option value="">All firms</option>
            {firms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Action
          <select name="action" defaultValue={action} className={select}>
            <option value="">All actions</option>
            {Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <button type="submit" className="rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Filter</button>
        {(firm || action) && <Link href="/platform/audit" className="py-2 text-accent underline-offset-2 hover:underline">Clear</Link>}
      </form>
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
      <Pager base="/platform/audit" page={page} hasNext={rows.length === 50} extra={extra} />
    </div>
  );
}
