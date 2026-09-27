import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { getClient } from "@/lib/clients/queries";
import { CLIENT_TYPE_LABEL } from "@/lib/validation/client";
import { Badge, Card } from "@/components/ui";
import { ArchiveControls } from "./archive-controls";

/**
 * Client page (mockup 11): header + client card. Step 8 of 02 adds Edit and Archive; the Settings tab
 * (collection plan) arrives in step 9. RLS returns nothing for a client a Limited user can't see → Not Found (AC-12).
 */
export default async function ClientPage({ params }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  if (!z.uuid().safeParse(id).success) notFound();
  const c = await getClient(id);
  if (!c) notFound();
  const gstins = c.registrations.filter((r) => r.kind === "gstin");
  const tans = c.registrations.filter((r) => r.kind === "tan");
  const canEdit = me.role !== "limited" && !c.archived;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <nav aria-label="Breadcrumb" className="text-[13.5px] text-ink-3"><Link href="/clients" className="hover:underline">Clients</Link> / {c.code}</nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight">{c.name}</h1>
          <p className="mt-1 text-ink-2">
            {[CLIENT_TYPE_LABEL[c.clientType], c.pan, gstins.length ? `${gstins.length} GSTIN${gstins.length > 1 ? "s" : ""}` : null, `Incharge ${c.inchargeName}`].filter(Boolean).join(" · ")}
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

      <Card className="p-6">
        <h2 className="sr-only">Client details</h2>
        <dl className="grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-3">
          <Item label="Client code">{c.code}</Item>
          <Item label="Client type">{CLIENT_TYPE_LABEL[c.clientType]}</Item>
          <Item label="PAN">{c.pan}</Item>
          <Item label="Incharge">{c.inchargeName}</Item>
          <Item label="Email">{c.email}</Item>
          <Item label="Mobile">{c.mobile}</Item>
          <Item label="Previous reference">{c.previousReference}</Item>
          <Item label="GSTIN">{gstins.length ? gstins.map((g) => <span key={g.number} className="block">{g.number}</span>) : null}</Item>
          <Item label="TAN">{tans.length ? tans.map((t) => <span key={t.number} className="block">{t.number}</span>) : null}</Item>
        </dl>
        <div className="mt-5 border-t border-line pt-4">
          <h2 className="text-[13.5px] font-medium text-ink-2">Document groups</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {c.groups.length === 0 && <span className="text-[13.5px] text-ink-3">None enabled yet.</span>}
            {c.groups.map((g) => <Badge key={g.name} tone={g.state === "paused" ? "muted" : "accent"}>{g.name}{g.state === "paused" ? " (paused)" : ""}</Badge>)}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="mt-0.5">{children ?? <span className="text-ink-3">—</span>}</dd>
    </div>
  );
}
