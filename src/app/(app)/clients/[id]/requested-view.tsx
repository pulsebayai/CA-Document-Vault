"use client";

import Link from "next/link";
import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, inputCls } from "@/components/dialog";
import { Badge, Button, Card } from "@/components/ui";
import { shortDate } from "@/lib/expected/schedule";
import { whatsappUrl } from "@/lib/reminders/message";
import {
  cancelRequestItem, recordLinkWhatsApp, reopenRequestItem, revokeLink, sendAgainPlan, sendLinkEmail, type SendAgainPlan,
} from "@/lib/upload-links/actions";
import type { LinkState, RequestedItem, Requested, RequestSummary } from "@/lib/upload-links/requested";

// Feature 10 step 9 — Client › Requested (spec AC-16, AC-18): the client's ad-hoc requested documents (open first,
// newest first) with Upload / Cancel / Reopen, then the client's upload links with Revoke and Send again.

const LINK_STATE: Record<LinkState, string> = { active: "Link open", expired: "Link expired", revoked: "Link revoked", replaced: "Sent again" };

type Perms = { canAct: boolean; meId: string; isManager: boolean; mobile: string | null; hasEmail: boolean };

export function RequestedView({ clientId, data, today, perms }: { clientId: string; data: Requested; today: string; perms: Perms }) {
  return (
    <div className="space-y-5">
      <Card>
        <section aria-labelledby="requested-h">
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <h3 id="requested-h" className="font-semibold">Requested documents</h3>
            <span className="text-[13px] text-ink-3">{data.openCount === 0 ? "None open" : `${data.openCount} open`}</span>
          </header>
          {data.items.length === 0 ? (
            <p className="px-5 py-4 text-[13.5px] text-ink-2">
              Nothing requested yet. Use Remind with &ldquo;Include upload link&rdquo; and &ldquo;+ Request another document&rdquo; to ask for a document that isn&apos;t on the plan.
            </p>
          ) : (
            <ul aria-label="Requested documents" className="divide-y divide-line">
              {data.items.map((i) => <ItemRow key={i.id} clientId={clientId} item={i} today={today} canAct={perms.canAct} />)}
            </ul>
          )}
        </section>
      </Card>
      <Card>
        <section aria-labelledby="links-h">
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <h3 id="links-h" className="font-semibold">Upload links</h3>
            <span className="text-[13px] text-ink-3">{data.requests.length === 0 ? "None yet" : `${data.requests.length} sent`}</span>
          </header>
          {data.requests.length === 0 ? (
            <p className="px-5 py-4 text-[13.5px] text-ink-2">No upload links sent to this client yet.</p>
          ) : (
            <ul aria-label="Upload links, newest first" className="divide-y divide-line">
              {data.requests.map((r) => <RequestRow key={r.id} clientId={clientId} r={r} today={today} perms={perms} />)}
            </ul>
          )}
        </section>
      </Card>
    </div>
  );
}

function itemTitle(i: RequestedItem) {
  return [i.group, i.type, i.period, i.registration].filter(Boolean).join(" · ");
}

function ItemRow({ clientId, item: i, today, canAct }: { clientId: string; item: RequestedItem; today: string; canAct: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const upload = `/documents/new?${new URLSearchParams({
    client: clientId, type: i.docTypeId, ...(i.periodId ? { period: i.periodId } : {}),
    ...(i.registrationId ? { registration: i.registrationId } : {}), item: i.id, from: `/clients/${clientId}?tab=requested`,
  })}`;
  const reopen = () => start(async () => {
    const r = await reopenRequestItem(i.id, clientId);
    setError(r.ok ? "" : r.error);
    router.refresh();
  });
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-medium">{itemTitle(i)}</p>
          <p className="mt-0.5 break-words text-[13px] text-ink-3">
            {[`Requested by ${i.requester} on ${shortDate(i.createdOn, today)}`,
              i.neededBy && `needed by ${shortDate(i.neededBy, today)}`,
              i.files > 0 && `${i.files} file${i.files > 1 ? "s" : ""}`,
              i.status !== "cancelled" && LINK_STATE[i.linkState]].filter(Boolean).join(" · ")}
          </p>
          {i.note && <p className="mt-1 break-words text-[13px]">“{i.note}”</p>}
          {i.status === "cancelled" && i.cancelReason && <p className="mt-1 break-words text-[13px] text-ink-3">Cancelled: {i.cancelReason}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {i.status === "received" ? <Badge tone="ok">Received{i.receivedOn ? ` ${shortDate(i.receivedOn, today)}` : ""}</Badge>
            : i.status === "cancelled" ? <Badge tone="muted">Cancelled</Badge>
            : i.overdue ? <Badge tone="bad">Overdue</Badge> : <Badge tone="warn">Open</Badge>}
          {canAct && i.status !== "cancelled" && (
            <Link href={upload} aria-label={`Upload ${i.type}`}
              className="inline-flex items-center rounded-[9px] border border-line-2 bg-panel px-3 py-1.5 text-[13.5px] font-medium hover:bg-canvas">Upload</Link>
          )}
          {canAct && i.status === "open" && (
            <Modal trigger="Cancel" title={`Cancel ${i.type}`} triggerVariant="button" triggerLabel={`Cancel ${i.type}`}>
              {(close) => <CancelBody clientId={clientId} itemId={i.id} close={close} />}
            </Modal>
          )}
          {canAct && i.status === "received" && (
            <Button type="button" size="sm" variant="secondary" disabled={pending} aria-label={`Reopen ${i.type}`} onClick={reopen}>Reopen</Button>
          )}
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p>}
    </li>
  );
}

function CancelBody({ clientId, itemId, close }: { clientId: string; itemId: string; close: () => void }) {
  const router = useRouter();
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const submit = () => start(async () => {
    const r = await cancelRequestItem(itemId, clientId, reason);
    if (!r.ok) { setError(r.error); return; }
    router.refresh();
    close();
  });
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4">
      <p className="text-[13.5px] text-ink-2">The client can no longer upload it through the link. This can&apos;t be undone; request it again if needed.</p>
      <div>
        <label htmlFor={`${id}-reason`} className="block text-[13.5px] font-medium">Reason</label>
        <textarea id={`${id}-reason`} value={reason} maxLength={300} rows={3} onChange={(e) => setReason(e.target.value)}
          className={inputCls} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} />
        {error && <p id={`${id}-err`} role="alert" className="mt-1 text-[13px] text-bad">{error}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>Keep it</Button>
        <Button type="submit" variant="danger" disabled={pending || !reason.trim()}>Cancel request</Button>
      </div>
    </form>
  );
}

function RequestRow({ clientId, r, today, perms }: { clientId: string; r: RequestSummary; today: string; perms: Perms }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const mine = r.requesterId === perms.meId || perms.isManager;
  const revoke = () => start(async () => {
    const x = await revokeLink(r.id, clientId);
    setError(x.ok ? "" : x.error);
    router.refresh();
  });
  const what = [r.scheduled && `${r.scheduled} expected`, r.adHoc && `${r.adHoc} requested`].filter(Boolean).join(", ");
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words">
            <span className="font-medium">{shortDate(r.createdOn, today)}</span>
            {` · ${r.channel === "email" ? "Email" : r.channel === "whatsapp" ? "WhatsApp" : "Link"} · `}
            <span className="text-ink-3">{r.requester}</span>
          </p>
          <p className="mt-0.5 break-words text-[13px] text-ink-3">
            {[what, `${r.openItems} still open`, `${r.files} file${r.files === 1 ? "" : "s"} uploaded`,
              r.linkState === "active" ? `open until ${shortDate(r.openUntil, today)}` : LINK_STATE[r.linkState]].filter(Boolean).join(" · ")}
          </p>
        </div>
        {perms.canAct && mine && (
          <div className="flex flex-wrap items-center gap-2">
            {r.linkState === "active" && (
              <Button type="button" size="sm" variant="danger" disabled={pending} aria-label={`Revoke the link of ${shortDate(r.createdOn, today)}`} onClick={revoke}>Revoke</Button>
            )}
            {r.linkState !== "replaced" && r.openItems > 0 && (
              <Modal trigger="Send again" title="Send the link again" triggerVariant="button" triggerLabel={`Send again the link of ${shortDate(r.createdOn, today)}`}>
                {(close) => <SendAgainBody clientId={clientId} requestId={r.id} perms={perms} close={close} />}
              </Modal>
            )}
          </div>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p>}
    </li>
  );
}

function SendAgainBody({ clientId, requestId, perms, close }: { clientId: string; requestId: string; perms: Perms; close: () => void }) {
  const router = useRouter();
  const [plan, setPlan] = useState<{ plan?: SendAgainPlan; error?: string }>({});
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    sendAgainPlan(requestId).then((r) => { if (live) setPlan(r.ok ? { plan: r.plan } : { error: r.error }); },
      () => live && setPlan({ error: "Could not load this link. Please try again." }));
    return () => { live = false; };
  }, [requestId]);
  if (plan.error) return <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] text-bad">{plan.error}</p>;
  if (!("plan" in plan)) return <p role="status" className="text-ink-2">Loading…</p>;
  const p = plan.plan;
  if (!p || p.scheduledIds.length + p.carryIds.length === 0) {
    return <><p className="text-ink-2">Nothing on this link is still open.</p><div className="mt-4 flex justify-end"><Button type="button" variant="secondary" onClick={close}>Close</Button></div></>;
  }
  const input = { clientId, itemIds: p.scheduledIds, adHoc: [], carry: p.carryIds, replaces: requestId };
  const email = () => start(async () => {
    const r = await sendLinkEmail(input);
    setResult(!r.ok ? { ok: false, text: r.error }
      : r.status === "failed" ? { ok: false, text: r.error ?? "Not sent." }
      : { ok: true, text: r.status === "sent" ? `New link sent to ${r.to}. The old link no longer works.` : "New link recorded, not emailed: this address doesn't receive email in this environment." });
    router.refresh();
  });
  const whatsapp = () => {
    const tab = window.open("", "_blank");
    start(async () => {
      const r = await recordLinkWhatsApp(input);
      if (r.ok && tab && perms.mobile) {
        tab.opener = null;
        tab.location.href = whatsappUrl(perms.mobile, r.text);
        setResult({ ok: true, text: "WhatsApp opened with the new link — press Send there. The old link no longer works." });
      } else {
        tab?.close();
        setResult({ ok: false, text: r.ok ? "Your browser blocked the WhatsApp tab. Allow pop-ups and try again." : r.error });
      }
      router.refresh();
    });
  };
  const done = result?.ok;
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] text-ink-2">A new link with the documents still open. The old link stops working.</p>
      <ul className="list-disc space-y-1 pl-5 text-[13.5px]">{p.lines.map((l) => <li key={l} className="break-words">{l}</li>)}</ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button type="button" disabled={pending || done || !perms.hasEmail} onClick={email}>Send email</Button>
        <Button type="button" variant="secondary" disabled={pending || done || !perms.mobile} onClick={whatsapp}>Open WhatsApp</Button>
      </div>
      <div aria-live="polite">
        {result && <p role={result.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-[13.5px] ${result.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{result.text}</p>}
      </div>
      <div className="flex justify-end"><Button type="button" variant="secondary" onClick={close}>Close</Button></div>
    </div>
  );
}
