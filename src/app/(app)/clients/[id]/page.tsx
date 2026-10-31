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
import { clientRemindersAs, itemHistoryAs } from "@/lib/reminders/queries";
import { RemindersList } from "./reminders-list";
import { openRequestedCount, requestedAs } from "@/lib/upload-links/requested";
import { RequestedView } from "./requested-view";
import { clientDscs, liveDscCount, remindDaysFor } from "@/lib/dsc/queries";
import { DscView } from "./dsc-view";
import { DscRemindCard } from "./dsc-remind-card";

/**
 * Client page (mockups 10–11; 02 AC-18, 03 AC-10, 04 AC-13/14): header and tabs Documents (default, 04 AC-14) ·
 * Expected · Requested (10: ad-hoc items and upload links) · Settings (the collection plan and the client card). Activity arrives with 08 (no dead tabs).
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
  // 10 AC-16: Requested (ad-hoc items + the client's upload links), with the open count on the tab.
  // 14 AC-1: DSC, with the live count on the tab.
  const tab = sp.tab === "settings" ? "settings" : sp.tab === "expected" ? "expected" : sp.tab === "requested" ? "requested"
    : sp.tab === "dsc" ? "dsc" : "documents";
  const [plan, docCount, documents, expected, fys, planGroups, requestedCount, dscCount, dscs, remindDays] = await Promise.all([
    tab === "settings" ? getClientPlan(c.id) : null,
    countClientDocuments(c.id),
    tab === "documents" ? listClientDocuments(c.id) : [],
    listClientExpected(me.officeId, c.id, { status: "all" }),
    tab !== "settings" ? listFinancialYears() : [],
    tab === "documents" ? listPlanGroups(c.id) : [],
    openRequestedCount(c.id),
    liveDscCount(c.id),
    tab === "dsc" ? clientDscs(c.id, me.officeId) : null,
    tab === "settings" ? remindDaysFor(c.id) : null,
  ]);
  const requested = tab === "requested" ? await requestedAs(c.id, expected.today) : null;
  // 06 AC-12: each expected row's reminder history; the Expected tab also lists the client's reminders.
  const [history, reminderList] = await Promise.all([
    tab !== "settings" ? itemHistoryAs(c.id, expected.today) : {},
    tab === "expected" ? clientRemindersAs(c.id) : [],
  ]);
  // Remind / Log call show only where the row's own actions do (not on an archived client); history always.
  const reminders = { clientName: c.name, history };
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
        <div className="flex flex-wrap items-center gap-2">
          {/* 08 AC-10: this client's history in Activity (the client ID is the only thing in the URL). */}
          <Link href={`/activity?client=${c.id}`} className="inline-flex items-center rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Activity</Link>
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

      {/* 10: four (14: five) tabs don't fit 390 px — the row scrolls sideways inside itself (relative: 02's sr-only rule). */}
      <nav aria-label="Client sections" className="relative overflow-x-auto border-b border-line">
        <ul className="flex gap-1 whitespace-nowrap">
          {([["documents", `Documents`, `/clients/${c.id}`], ["expected", "Expected", `/clients/${c.id}?tab=expected`],
            ["requested", "Requested", `/clients/${c.id}?tab=requested`],
            ["dsc", "DSC", `/clients/${c.id}?tab=dsc`],
            ["settings", "Settings", `/clients/${c.id}?tab=settings`]] as const).map(([key, label, href]) => (
            <li key={key}>
              <Link href={href} aria-current={tab === key ? "page" : undefined}
                className={`-mb-px inline-block border-b-2 px-3 py-2 text-[14px] ${tab === key ? "border-ink font-medium" : "border-transparent text-ink-2 hover:text-ink"}`}>
                {label}{key === "documents" && <span className="ml-1 text-ink-3">{docCount}</span>}
                {key === "expected" && <span className="ml-1 text-ink-3">{expected.open}</span>}
                {key === "requested" && <span className="ml-1 text-ink-3">{requestedCount}</span>}
                {key === "dsc" && dscCount !== null && <span className="ml-1 text-ink-3">{dscCount}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "documents" ? (
        <div>
          <h2 className="sr-only">Documents</h2>
          <DocumentsView clientId={c.id} documents={documents} currentFy={fyCodeOf(expected.today)}
            expected={expected.items} planGroups={planGroups} fys={fys} canUpload={!c.archived} today={expected.today} clientName={c.name}
            reminders={reminders} />
        </div>
      ) : tab === "expected" ? (
        <div>
          <h2 className="sr-only">Expected documents</h2>
          <ExpectedView clientId={c.id} items={expected.items} fys={fys}
            currentFyId={fys.find((f) => f.code === fyCodeOf(expected.today))?.id ?? null}
            perms={{ canAct: !c.archived, canWaive: me.role !== "limited" && !c.archived, canUndo: canManage }}
            reminders={reminders} />
          <div className="mt-5"><RemindersList entries={reminderList} today={expected.today} /></div>
        </div>
      ) : tab === "requested" ? (
        <div>
          <h2 className="sr-only">Requested documents</h2>
          <RequestedView clientId={c.id} data={requested!} today={expected.today}
            perms={{ canAct: !c.archived, meId: me.id, isManager: canManageCatalogue(me.role), mobile: c.mobile, hasEmail: !!c.email }} />
        </div>
      ) : tab === "dsc" ? (
        <div>
          <h2 className="sr-only">Digital signatures (DSC)</h2>
          <DscView clientId={c.id} data={dscs!}
            perms={{ canEdit: me.role !== "limited" && !c.archived, canReveal: me.role !== "limited",
              canArchive: canManageCatalogue(me.role) && !c.archived, canCustody: !c.archived }} />
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
        <DscRemindCard clientId={c.id} days={remindDays ?? 30} canEdit={canEdit} />
        <Card className="p-5">
          <h2 className="font-semibold">Client reminders</h2>
          <p className="mt-2 text-[13.5px] text-ink-2">
            Reminders go to the client&apos;s email and mobile above. <Link href={`/clients/${c.id}?tab=expected`} className="font-medium text-accent hover:underline">See the reminders sent</Link>.
          </p>
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
