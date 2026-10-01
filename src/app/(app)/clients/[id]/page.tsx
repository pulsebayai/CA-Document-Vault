import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { getClient } from "@/lib/clients/queries";
import { CLIENT_TYPE_LABEL } from "@/lib/validation/client";
import { getClientPlan } from "@/lib/plan/queries";
import { countClientDocuments, listClientDocuments } from "@/lib/documents/queries";
import { fyCodeOf } from "@/lib/documents/period";
import { DocumentsView } from "./documents-view";
import { listClientExpected, listFinancialYears, listPlanGroups } from "@/lib/expected/queries";
import { ExpectedView } from "./expected-view";
import { Card } from "@/components/ui";
import { ArchiveControls } from "./archive-controls";
import { PlanView } from "./plan-view";

/**
 * Client page (mockups 10–11; 02 AC-18, 03 AC-10, 04 AC-13/14): header and tabs Documents (default, 04 AC-14) ·
 * Expected · Settings (the collection plan and the client card). Activity arrives with 08 (no dead tabs).
 * RLS returns nothing for a client a Limited user can't see → Not Found (AC-12).
 */
export default async function ClientPage({ params, searchParams }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  // After Add document (spec AC-4): "DOC-FY26-27-00126 saved". Only a well-formed DOC-ID is ever echoed.
  const saved = typeof sp.saved === "string" && /^DOC-FY\d{2}-\d{2}-\d{5,}$/.test(sp.saved) ? sp.saved : null;
  const me = await requireStaff();
  if (!z.uuid().safeParse(id).success) notFound();
  const c = await getClient(id);
  if (!c) notFound();
  // 04 AC-14: Documents is the default tab (?tab=documents still works for 03's links); Settings is ?tab=settings.
  // 04 AC-13: Expected, with the open count (Due + Overdue, every FY) on the tab, whichever tab is shown.
  const tab = sp.tab === "settings" ? "settings" : sp.tab === "expected" ? "expected" : "documents";
  const [plan, docCount, documents, expected, fys, planGroups] = await Promise.all([
    tab === "settings" ? getClientPlan(c.id) : null,
    countClientDocuments(c.id),
    tab === "documents" ? listClientDocuments(c.id) : [],
    listClientExpected(me.officeId, c.id, { status: "all" }),
    tab !== "settings" ? listFinancialYears() : [],
    tab === "documents" ? listPlanGroups(c.id) : [],
  ]);
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
          {!c.archived && (
            <Link href={`/documents/new?client=${c.id}&from=/clients/${c.id}`} className="inline-flex items-center rounded-[9px] bg-accent px-3.5 py-2 font-medium text-white hover:bg-[#264d8f]">Add document</Link>
          )}
          {canEdit && <Link href={`/clients/${c.id}/edit`} className="inline-flex items-center rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Edit</Link>}
          {canManageCatalogue(me.role) && <ArchiveControls id={c.id} name={c.name} archived={c.archived} />}
        </div>
      </div>

      {saved && <p role="status" className="rounded-lg bg-ok-soft px-4 py-3 text-[13.5px] text-ok"><strong className="font-semibold">{saved}</strong> saved.</p>}

      {c.archived && (
        <p role="status" className="rounded-lg bg-warn-soft px-4 py-3 text-[13.5px] text-warn">
          This client is archived. It is hidden from the client list and can&apos;t be edited until it is unarchived.
          {c.archiveReason && <> Reason: {c.archiveReason}</>}
        </p>
      )}

      <nav aria-label="Client sections" className="border-b border-line">
        <ul className="flex gap-1">
          {([["documents", `Documents`, `/clients/${c.id}`], ["expected", "Expected", `/clients/${c.id}?tab=expected`],
            ["settings", "Settings", `/clients/${c.id}?tab=settings`]] as const).map(([key, label, href]) => (
            <li key={key}>
              <Link href={href} aria-current={tab === key ? "page" : undefined}
                className={`-mb-px inline-block border-b-2 px-3 py-2 text-[14px] ${tab === key ? "border-ink font-medium" : "border-transparent text-ink-2 hover:text-ink"}`}>
                {label}{key === "documents" && <span className="ml-1 text-ink-3">{docCount}</span>}
                {key === "expected" && <span className="ml-1 text-ink-3">{expected.open}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "documents" ? (
        <div>
          <h2 className="sr-only">Documents</h2>
          <DocumentsView clientId={c.id} documents={documents} currentFy={fyCodeOf(expected.today)}
            expected={expected.items} planGroups={planGroups} fys={fys} canUpload={!c.archived} today={expected.today} />
        </div>
      ) : tab === "expected" ? (
        <div>
          <h2 className="sr-only">Expected documents</h2>
          <ExpectedView clientId={c.id} items={expected.items} fys={fys}
            currentFyId={fys.find((f) => f.code === fyCodeOf(expected.today))?.id ?? null}
            perms={{ canAct: !c.archived, canWaive: me.role !== "limited" && !c.archived, canUndo: canManage }} />
        </div>
      ) : (
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <h2 className="sr-only">Collection plan</h2>
          <PlanView clientId={c.id} plan={plan!} inchargeId={c.inchargeId} canEdit={canEdit} canManage={canManage}
            activeKinds={[...new Set(c.registrations.map((r) => r.kind))]}
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
      )}
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
