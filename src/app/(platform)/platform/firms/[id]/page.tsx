import { inviteAdmin, openAccess, reactivateFirm, resendInvite, suspendFirm } from "@/lib/platform/actions";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { getFirm, inviteTarget } from "@/lib/platform/queries";
import { Card } from "@/components/ui";
import { ActionButton, ReasonForm } from "../../client-bits";
import { FirmForm } from "../new/firm-form";
import { Field, dateTime } from "../../ui";

export const dynamic = "force-dynamic";

/** 19 (spec Y4, Y6, Y7): a firm's counts, its first Admin's invite, suspend / reactivate, and support access. */
export default async function FirmPage({ params, searchParams }: PageProps<"/platform/firms/[id]">) {
  const { id } = await params;
  const { created, invite } = await searchParams;
  const [me, firm, waiting] = await Promise.all([requirePlatformAdmin(), getFirm(id), inviteTarget(id)]);
  const noStaff = firm.staff_active + firm.staff_invited === 0;
  return (
    <div className="space-y-5">
      {created === "1" && <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-[13.5px] text-ok">Firm created and the first Admin invited.</p>}
      {invite === "failed" && noStaff && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] text-bad">The firm was created, but the invite failed. Invite the first Admin below.</p>}

      <Card className="p-6">
        <h2 className="mb-3 font-semibold">Usage</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Staff">{firm.staff_active}{firm.staff_invited > 0 && ` + ${firm.staff_invited} invited`}</Field>
          <Field label="Clients">{firm.clients}</Field>
          <Field label="Documents">{firm.documents}</Field>
          <Field label="Storage">{firm.storage_mb} MB</Field>
          <Field label="Created">{dateTime(firm.created_at)}</Field>
          <Field label="Last activity">{dateTime(firm.last_activity_at)}</Field>
        </dl>
      </Card>

      {(noStaff || waiting) && (
        <Card className="p-6">
          <h2 className="mb-3 font-semibold">First Admin</h2>
          {waiting ? (
            <div className="space-y-3">
              <p className="text-ink-2">{waiting.full_name} hasn&apos;t signed in yet.</p>
              <ActionButton run={resendInvite.bind(null, id, firm.name)} pendingLabel="Sending…">Resend invite</ActionButton>
            </div>
          ) : (
            <FirmForm action={inviteAdmin.bind(null, id, firm.name)} test={me.test} adminOnly />
          )}
        </Card>
      )}

      <Card className="p-6">
        <h2 className="mb-1 font-semibold">Support access</h2>
        {firm.my_access ? (
          <p className="text-ink-2">Open until {dateTime(firm.my_access.expires_at)}. Use the tabs above; close it from the banner when you&apos;re done.</p>
        ) : (
          <>
            <p className="mb-4 max-w-prose text-[13.5px] text-ink-2">
              Read-only for 60 minutes: clients (with PAN, email and mobile), documents, expected documents and activity. No file
              downloads or DSC passwords. The firm&apos;s Admins see it in their Activity and bell, with every page you open.
            </p>
            <ReasonForm id="access" action={openAccess.bind(null, id)} label="Reason" hint="For example the support ticket and what you need to check (10–500 characters). The firm can't see it; the platform audit log keeps it."
              submit="Open read access" pendingLabel="Opening…" />
          </>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-1 font-semibold">{firm.status === "suspended" ? "Suspended" : "Suspend this firm"}</h2>
        {firm.status === "suspended" ? (
          <div className="space-y-3">
            <p className="text-ink-2">Since {dateTime(firm.suspended_at)}. Its staff can&apos;t sign in, client upload links don&apos;t work, and no reminders or expected documents are generated. Nothing is deleted.</p>
            <ActionButton run={reactivateFirm.bind(null, id)} pendingLabel="Reactivating…" variant="primary">Reactivate firm</ActionButton>
          </div>
        ) : (
          <>
            <p className="mb-4 max-w-prose text-[13.5px] text-ink-2">
              Its staff are signed out on their next request and can&apos;t sign in, client upload links stop working, and the nightly job skips it.
              Nothing is deleted; reactivating restores everything.
            </p>
            <ReasonForm id="suspend" action={suspendFirm.bind(null, id)} label="Reason" hint="Kept in the platform audit log (10–500 characters). The firm's staff see only that access is paused."
              submit="Suspend firm" pendingLabel="Suspending…" variant="danger" />
          </>
        )}
      </Card>
    </div>
  );
}
