import Link from "next/link";
import { closeAccess } from "@/lib/platform/actions";
import { getFirm } from "@/lib/platform/queries";
import { Badge } from "@/components/ui";
import { ActionButton, Countdown, Notices } from "../../client-bits";
import { Back } from "../../ui";

export const dynamic = "force-dynamic";

/** 19: one firm — its name, status, the support-access banner (spec Y4) and the read views' tabs. */
export default async function FirmLayout({ children, params }: LayoutProps<"/platform/firms/[id]">) {
  const { id } = await params;
  const firm = await getFirm(id);
  const base = `/platform/firms/${id}`;
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/clients`, label: "Clients" },
    { href: `${base}/documents`, label: "Documents" },
    { href: `${base}/activity`, label: "Activity" },
  ];
  return (
    <div className="mx-auto max-w-[1100px]">
      <Back href="/platform">Firms</Back>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-semibold leading-tight">{firm.name}</h1>
        {firm.branch && <span className="text-ink-3">{firm.branch}</span>}
        {firm.status === "suspended" ? <Badge tone="bad">Suspended</Badge> : <Badge tone="ok">Active</Badge>}
      </div>
      <Notices />
      {firm.my_access && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-accent-soft px-4 py-3 text-[13.5px]">
          <p><span className="font-semibold">Read-only support access</span> · ends in <Countdown expiresAt={firm.my_access.expires_at} /> · every page you open is logged and the firm&apos;s Admins are told</p>
          <div className="ml-auto"><ActionButton run={closeAccess.bind(null, id, firm.my_access.id)} pendingLabel="Closing…">Close access</ActionButton></div>
        </div>
      )}
      <nav aria-label="Firm" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <Link prefetch={false} key={t.href} href={t.href} className="whitespace-nowrap px-3 py-2 text-[13.5px] text-ink-2 hover:text-ink">{t.label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
