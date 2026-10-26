"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, inputCls } from "@/components/dialog";
import { Button, Switch } from "@/components/ui";
import { addDays } from "@/lib/expected/schedule";
import { buildReminderMessage, whatsappUrl } from "@/lib/reminders/message";
import { recordLinkWhatsApp, retryLinkEmail, revokeLink, sendLinkEmail, type LinkEmailResult } from "@/lib/upload-links/actions";
import { AdHocEditor, adHocPreview, adHocProblems, useLinkOptions, type AdHocRow } from "./link-section";
import { logCall, recordWhatsApp, remindDialog, sendEmailReminder, type SendEmailResult } from "@/lib/reminders/actions";
import type { RemindDialogData } from "@/lib/reminders/queries";
import type { DialogItem } from "@/lib/reminders/shape";

// Feature 06 — Remind (AC-7…AC-10) and Log call (AC-11) dialogs, shared by Today, Client › Documents and
// Client › Expected. Both list ALL the client's open items: ticked, except items whose plan row has reminders off.
// The preview is built with the same pure builder the server uses at Send, from the same data; the server rebuilds
// it from the database, so what is sent never comes from the browser. The WhatsApp chat opens from the click itself
// (popup blockers allow it), then the follow-up is recorded.

/** What the client page passes to its Documents / Expected views (AC-12): the client's name and each item's history. */
export type ReminderProps = { clientName: string; history: Record<string, string> };

const TIME = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

function useDialogData(clientId: string) {
  const [state, setState] = useState<{ data?: RemindDialogData; error?: string }>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    remindDialog(clientId).then((r) => {
      if (!live) return;
      if (r.ok) {
        setState({ data: r.data });
        setTicked(new Set(r.data.items.filter((i) => i.ticked).map((i) => i.id)));
      } else setState({ error: r.error });
    }, () => live && setState({ error: "Could not load this client's open documents. Please try again." }));
    return () => { live = false; };
  }, [clientId]);
  const toggle = (id: string) => setTicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { ...state, ticked, toggle };
}

function ItemPicker({ items, ticked, toggle }: { items: DialogItem[]; ticked: Set<string>; toggle: (id: string) => void }) {
  if (items.length === 0) return <p className="text-ink-2">This client has no open documents.</p>;
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium text-ink-2">Open documents</legend>
      <ul aria-label="Open documents" tabIndex={0} className="relative max-h-60 space-y-2 overflow-y-auto pr-1 focus-visible:outline-2 focus-visible:outline-accent">
        {items.map((i) => (
          <li key={i.id}>
            <label className="flex items-start gap-2.5">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={ticked.has(i.id)} onChange={() => toggle(i.id)} />
              <span className="min-w-0">
                <span className="block break-words">{i.group} · {i.type} · {i.period}</span>
                <span className={`block text-[13px] ${i.kind === "overdue" ? "text-bad" : i.kind === "due_today" ? "text-warn" : "text-ink-3"}`}>
                  {i.stateText} · {i.history}{i.reminders ? "" : " · reminders off"}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

const Loading = () => <p role="status" className="text-ink-2">Loading open documents…</p>;
const Failed = ({ error }: { error: string }) => <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] text-bad">{error}</p>;

/** Remind (AC-7): the dialog trigger. `label` names the client for screen readers ("Remind Meena Exports"). */
export function RemindButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  return (
    <Modal trigger="Remind" title={`Remind ${clientName}`} triggerVariant="button" triggerLabel={`Remind ${clientName}`}>
      {(close) => <RemindBody clientId={clientId} close={close} />}
    </Modal>
  );
}

function RemindBody({ clientId, close }: { clientId: string; close: () => void }) {
  const router = useRouter();
  const { data, error, ticked, toggle } = useDialogData(clientId);
  const [pending, start] = useTransition();
  const [sent, setSent] = useState<SendEmailResult | null>(null);
  const [wa, setWa] = useState<{ ok: boolean; error?: string } | null>(null);
  const previewId = useId();
  // Feature 10: "Include upload link" (off by default — the dialog is 06's own until it's switched on).
  const [linkOn, setLinkOn] = useState(false);
  const [rows, setRows] = useState<AdHocRow[]>([]);
  const [linkSent, setLinkSent] = useState<LinkEmailResult | null>(null);
  const [linkWa, setLinkWa] = useState<{ ok: true; openUntil: string; requestId: string } | { ok: false; error: string } | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  const link = useLinkOptions(clientId, linkOn);

  const chosen = useMemo(() => data?.items.filter((i) => ticked.has(i.id)) ?? [], [data, ticked]);
  const adHoc = useMemo(() => (linkOn ? adHocPreview(rows, link.data) : []), [linkOn, rows, link.data]);
  const preview = useMemo(() => {
    if (!data || chosen.length + adHoc.length === 0) return "";
    if (!linkOn || !link.data?.base) {
      return chosen.length === 0 ? "" : buildReminderMessage({
        clientName: data.client.name, items: chosen, senderName: data.sender.name, firmName: data.sender.firm, today: data.today,
      }).text;
    }
    // The real link is made at Send; the preview shows where it goes, never a token.
    const placeholder = `${link.data.base}/u#${"X".repeat(43)}`;
    return buildReminderMessage({
      clientName: data.client.name, items: chosen, adHoc, senderName: data.sender.name, firmName: data.sender.firm, today: data.today,
      uploadLink: { url: placeholder, openUntil: addDays(data.today, 14) },
    }).text.replace(placeholder, "‹secure upload link›");
  }, [data, chosen, adHoc, linkOn, link.data]);

  if (error) return <><Failed error={error} /><Footer close={close} /></>;
  if (!data) return <Loading />;

  const linkProblem = !linkOn ? null
    : link.error ? link.error
    : !link.data ? "Loading document types…"
    : !link.data.enabled ? "Upload links aren't set up in this environment."
    : adHocProblems(rows, data.today);
  const nothingChosen = chosen.length === 0 && !(linkOn && rows.length > 0);

  const emailedToday = data.emailedToday ?? (sent?.ok && sent.status !== "failed" ? { at: sent.at, by: data.sender.name } : null);
  const emailBlocked = !data.client.emailMasked ? "No email on file — add one in Settings."
    : emailedToday ? `Emailed today at ${TIME.format(new Date(emailedToday.at))} by ${emailedToday.by}. One email per client per day.`
    : data.dailyLimitReached ? "Daily email limit reached — use WhatsApp or try tomorrow."
    : nothingChosen ? "Choose at least one document." : linkProblem;
  const waBlocked = !data.client.mobile ? "No mobile number on file — add one in Settings."
    : nothingChosen ? "Choose at least one document." : linkProblem;

  const linkInput = () => ({
    clientId, itemIds: chosen.map((i) => i.id),
    adHoc: rows.map((r) => ({ docTypeId: r.docTypeId, periodId: r.periodId || null, registrationId: r.registrationId || null,
      neededBy: r.neededBy || null, note: r.note.trim() || null })),
  });
  const sendEmail = () => start(async () => {
    if (linkOn) {
      setLinkSent(await sendLinkEmail(linkInput()));
    } else {
      setSent(await sendEmailReminder(clientId, chosen.map((i) => i.id)));
    }
    router.refresh();
  });
  const retryLink = (requestId: string) => start(async () => { setLinkSent(await retryLinkEmail(requestId)); router.refresh(); });
  const revoke = (requestId: string) => start(async () => {
    const r = await revokeLink(requestId, clientId);
    setRevoked(r.ok ? requestId : null);
    if (!r.ok) setLinkWa({ ok: false, error: r.error });
    router.refresh();
  });
  const openWhatsApp = () => {
    if (linkOn) {
      // The tab opens from the click (popup blockers); the link is made on the server, then the tab goes to wa.me.
      const tab = window.open("", "_blank");
      start(async () => {
        const r = await recordLinkWhatsApp(linkInput());
        if (r.ok && tab) {
          tab.opener = null;
          tab.location.href = whatsappUrl(data.client.mobile!, r.text);
          setLinkWa({ ok: true, openUntil: r.openUntil, requestId: r.requestId });
        } else {
          tab?.close();
          setLinkWa({ ok: false, error: r.ok ? "Your browser blocked the WhatsApp tab. Allow pop-ups and try again." : r.error });
        }
        router.refresh();
      });
      return;
    }
    // Opened from the click itself so popup blockers allow it; the URL is built here, never on our servers.
    window.open(whatsappUrl(data.client.mobile!, preview), "_blank", "noopener,noreferrer");
    start(async () => {
      const r = await recordWhatsApp(clientId, chosen.map((i) => i.id));
      // Review N-7: the chat is already open; if recording failed, say how to keep the record straight.
      setWa(r.ok ? { ok: true } : { ok: false, error: `WhatsApp opened, but it wasn't recorded: ${r.error} If you send it, use Log call to record it.` });
      router.refresh();
    });
  };

  const linkDone = (linkSent?.ok && linkSent.status !== "failed") || linkWa?.ok;
  return (
    <div className="space-y-4">
      <ItemPicker items={data.items} ticked={ticked} toggle={toggle} />
      <div className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">Include upload link</p>
            <p className="text-[12.5px] text-ink-3">The client uploads these documents straight into the vault. Open for 14 days.</p>
          </div>
          <Switch checked={linkOn} label="Include upload link" disabled={pending || Boolean(linkDone)} onChange={setLinkOn} />
        </div>
        {linkOn && link.data?.enabled && (
          <div className="mt-3">
            <AdHocEditor rows={rows} setRows={setRows} options={link.data} today={data.today} disabled={pending || Boolean(linkDone)} />
          </div>
        )}
      </div>
      {(data.items.length > 0 || (linkOn && rows.length > 0)) && (
        <div>
          <h3 id={previewId} className="mb-1 text-[13px] font-medium text-ink-2">Message preview</h3>
          {/* Scrolls when long: focusable + named, so keyboard users can scroll it (axe scrollable-region-focusable). */}
          <div role="region" aria-labelledby={previewId} tabIndex={0}
            className="relative max-h-48 overflow-y-auto rounded-lg border border-line bg-canvas p-3 focus-visible:outline-2 focus-visible:outline-accent">
            <pre className="whitespace-pre-wrap font-sans text-[13px]">{preview || "Choose at least one document to see the message."}</pre>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Button type="button" className="w-full" disabled={pending || Boolean(emailBlocked) || Boolean(linkDone)} onClick={sendEmail}>Send email</Button>
          {emailBlocked && <p className="mt-1 text-[12.5px] text-ink-3">{emailBlocked}</p>}
        </div>
        <div>
          <Button type="button" variant="secondary" className="w-full" disabled={pending || Boolean(waBlocked) || Boolean(linkDone)} onClick={openWhatsApp}>Open WhatsApp</Button>
          {waBlocked ? <p className="mt-1 text-[12.5px] text-ink-3">{waBlocked}</p>
            : <p className="mt-1 text-[12.5px] text-ink-3">Opens your WhatsApp — press Send there.</p>}
        </div>
      </div>

      <div aria-live="polite">
        {sent && !sent.ok && <Failed error={sent.error} />}
        {sent?.ok && sent.status === "sent" && <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-[13.5px] text-ok">Sent to {sent.to}, {TIME.format(new Date(sent.at))}.</p>}
        {sent?.ok && sent.status === "suppressed" && <p role="status" className="rounded-lg bg-canvas px-3 py-2 text-[13.5px] text-ink-2">Recorded, not sent: this address doesn&apos;t receive email in this environment.</p>}
        {sent?.ok && sent.status === "failed" && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] text-bad">
            {sent.error}<Button type="button" size="sm" variant="secondary" disabled={pending} onClick={sendEmail}>Retry</Button>
          </div>
        )}
        {wa?.ok && <p role="status" className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-[13.5px] text-ok">WhatsApp opened and recorded.</p>}
        {wa && !wa.ok && <Failed error={wa.error ?? ""} />}
        {linkSent && !linkSent.ok && <Failed error={linkSent.error} />}
        {linkSent?.ok && linkSent.status !== "failed" && (
          <LinkDone text={linkSent.status === "sent" ? `Link sent to ${linkSent.to}` : "Link recorded, not emailed: this address doesn't receive email in this environment"}
            openUntil={linkSent.openUntil} revoked={revoked === linkSent.requestId} pending={pending} onRevoke={() => revoke(linkSent.requestId)} />
        )}
        {linkSent?.ok && linkSent.status === "failed" && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] text-bad">
            {linkSent.error}<Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => retryLink(linkSent.requestId)}>Retry</Button>
          </div>
        )}
        {linkWa?.ok && (
          <LinkDone text="WhatsApp opened with the link — press Send there" openUntil={linkWa.openUntil}
            revoked={revoked === linkWa.requestId} pending={pending} onRevoke={() => revoke(linkWa.requestId)} />
        )}
        {linkWa && !linkWa.ok && <Failed error={linkWa.error} />}
      </div>
      <Footer close={close} />
    </div>
  );
}

function LinkDone({ text, openUntil, revoked, pending, onRevoke }: {
  text: string; openUntil: string; revoked: boolean; pending: boolean; onRevoke: () => void;
}) {
  const until = new Date(`${openUntil}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return (
    <div role="status" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-ok-soft px-3 py-2 text-[13.5px] text-ok">
      {revoked ? "Link revoked — it no longer works." : <>{text} · open until {until}.
        <Button type="button" size="sm" variant="danger" disabled={pending} onClick={onRevoke}>Revoke</Button></>}
    </div>
  );
}

function Footer({ close }: { close: () => void }) {
  return <div className="flex justify-end border-t border-line pt-3"><Button type="button" variant="secondary" onClick={close}>Close</Button></div>;
}

/** Log call (AC-11): items, date (default today, not future), optional note ≤ 300. */
export function LogCallButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  return (
    <Modal trigger="Log call" title={`Log a call with ${clientName}`} triggerVariant="button" triggerLabel={`Log call with ${clientName}`}>
      {(close) => <LogCallBody clientId={clientId} close={close} />}
    </Modal>
  );
}

function LogCallBody({ clientId, close }: { clientId: string; close: () => void }) {
  const router = useRouter();
  const { data, error, ticked, toggle } = useDialogData(clientId);
  const [on, setOn] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dateId = useId();
  const noteId = useId();
  if (error) return <><Failed error={error} /><Footer close={close} /></>;
  if (!data) return <Loading />;
  const date = on ?? data.today;
  const save = () => start(async () => {
    const r = await logCall({ clientId, itemIds: [...ticked], on: date, note: note.trim() || null });
    if (r.ok) { router.refresh(); close(); } else setResult(r.error);
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <ItemPicker items={data.items} ticked={ticked} toggle={toggle} />
      <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
        <div>
          <label htmlFor={dateId} className="text-[13px] font-medium text-ink-2">Date of call</label>
          <input id={dateId} type="date" className={inputCls} value={date} max={data.today} required onChange={(e) => setOn(e.target.value)} />
        </div>
        <div>
          <label htmlFor={noteId} className="text-[13px] font-medium text-ink-2">Note (optional)</label>
          <textarea id={noteId} className={inputCls} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          <p className="mt-0.5 text-right text-[12px] text-ink-3">{note.length}/300</p>
        </div>
      </div>
      {result && <Failed error={result} />}
      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending || ticked.size === 0}>Save call</Button>
      </div>
    </form>
  );
}
