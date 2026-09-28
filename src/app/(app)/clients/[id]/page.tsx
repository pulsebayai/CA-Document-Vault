import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { getClient } from "@/lib/clients/queries";
import { CLIENT_TYPE_LABEL } from "@/lib/validation/client";
import { getClientPlan } from "@/lib/plan/queries";
import { Card } from "@/components/ui";
import { ArchiveControls } from "./archive-controls";
import { PlanView } from "./plan-view";

/**
 * Client page (mockup 11, spec AC-18): header, tabs, the collection plan (Settings tab) and the client card.
 * In 02 only Settings exists; Documents / Expected / Activity arrive with 03 / 04 / 08 (no dead tabs).
 * RLS returns nothing for a client a Limited user can't see → Not Found (AC-12).
 */
export default async function ClientPage({ params }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  if (!z.uuid().safeParse(id).success) notFound();
  const c = await getClient(id);
  if (!c) notFound();
  const plan = await getClientPlan(c.id);
  const gstins = c.registrations.filter((r) => r.kind === "gstin");
  const tans = c.registrations.filter((r) => r.kind === "tan");
  const canEdit = me.role !== "limited" && !c.archived;
  const canManage = canManageCatalogue(me.role) && !c.archived;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <nav aria-label="Breadcrumb" className="text-[13.5px] text-ink-3"><Link href="/clients" className="hover:underline">Clients</Link> / {c.code}</nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight">{c.name}</h1>
          <p className="mt-1 break-words text-ink-2">
            {[CLIENT_TYPE_LABEL[c.clientType], c.pan && `PAN ${c.pan}`, gstins.length ? `${gstins.length} GSTIN${gstins.length > 1 ? "s" : ""}` : null,
              `Incharge ${c.inchargeName}`, c.email, c.mobile].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && <Link href={`/clients/${c.id}/edit`} className="inline-flex items-center rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Edit</Link>}
          {canManageCatalogue(me.role) && <ArchiveControls id={c.id} name={c.name} archived={c.archived} />}
        </div>
      </div>

      {c.archived && (
        <p role="status" className="rounded-lg bg-warn-soft px-4 py-3 text-[13.5px] text-warn">
          This client is archived. It is hidden from the client list and can&apos;t be edited until it is unarchived.
          {c.archiveReason && <> Reason: {c.archiveReason}</>}
        </p>
      )}

      <nav aria-label="Client sections" className="border-b border-line">
        <ul className="flex gap-1">
          <li>
            <Link href={`/clients/${c.id}`} aria-current="page"
              className="-mb-px inline-block border-b-2 border-ink px-3 py-2 text-[14px] font-medium">Settings</Link>
          </li>
        </ul>
      </nav>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <h2 className="sr-only">Collection plan</h2>
          <PlanView clientId={c.id} plan={plan} inchargeId={c.inchargeId} canEdit={canEdit} canManage={canManage}
            note={me.role === "limited" ? "You can view this plan. Staff and above can change it." : undefined} />
        </div>
        <div className="space-y-5">
        <Card className="p-5">
          <h2 className="font-semibold">Client</h2>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[14px]">
            <Item label="Client code">{c.code}</Item>
            <Item label="Client type">{CLIENT_TYPE_LABEL[c.clientType]}</Item>
            <Item label="PAN">{c.pan}</Item>
            <Item label="GSTIN">{gstins.length ? gstins.map((g) => <span key={g.number} className="block">{g.number}</span>) : null}</Item>
            <Item label="TAN">{tans.length ? tans.map((t) => <span key={t.number} className="block">{t.number}</span>) : null}</Item>
            <Item label="Incharge">{c.inchargeName}</Item>
            <Item label="Email">{c.email}</Item>
            <Item label="Mobile">{c.mobile}</Item>
            <Item label="Previous reference">{c.previousReference}</Item>
          </dl>
        </Card>
        {/* Spec 02 UX: read-only until reminders ship (06). */}
        <Card className="p-5">
          <h2 className="font-semibold">Client reminders</h2>
          <p className="mt-2 text-[13.5px] text-ink-2">Reminders arrive with feature 06.</p>
        </Card>
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
