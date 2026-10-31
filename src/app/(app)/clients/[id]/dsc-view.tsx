"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card } from "@/components/ui";
import { FieldError, Modal, inputCls } from "@/components/dialog";
import {
  archiveDsc, changeDscPassword, logDscCustody, revealDscPassword, saveDsc, unarchiveDsc,
} from "@/lib/dsc/actions";
import { custodyText, expiryStatus, shortDate } from "@/lib/dsc/expiry";
import type { ClientDscs, DscRecord } from "@/lib/dsc/queries";
import { DSC_CLASSES, DSC_ISSUERS, MAX_PASSWORD, dscClassLabel } from "@/lib/validation/dsc";

// Feature 14 — Client › DSC (spec AC-1 … AC-9). One card per DSC, soonest expiry first; archived DSCs under
// "Show archived". The password is never in the page: "Show password" fetches it for 30 seconds (AC-7), and each
// click is a new, logged reveal.

export type DscPerms = { canEdit: boolean; canReveal: boolean; canArchive: boolean; canCustody: boolean };
type Fe = Record<string, string | undefined>;

export const REVEAL_SECONDS = 30;

export function DscView({ clientId, data, perms }: { clientId: string; data: ClientDscs; perms: DscPerms }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-ink-2">
          Digital signature certificates held for this client. Expiry reminders show on Today {data.remindDays} days ahead
          {perms.canEdit ? <> (change it in <a href={`/clients/${clientId}?tab=settings`} className="font-medium text-accent hover:underline">Settings</a>)</> : null}.
        </p>
        {perms.canEdit && (
          <Modal trigger="Add DSC" title="Add DSC" triggerVariant="primary">
            {(close) => <DscForm clientId={clientId} onDone={close} />}
          </Modal>
        )}
      </div>
      {data.live.length === 0 ? (
        <Card className="p-6 text-center text-ink-2">No DSCs yet.{perms.canEdit ? " Use Add DSC to record one." : ""}</Card>
      ) : (
        <ul className="space-y-3">
          {data.live.map((d) => (
            <li key={d.id}><DscCard clientId={clientId} d={d} today={data.today} remindDays={data.remindDays} perms={perms} /></li>
          ))}
        </ul>
      )}
      {data.archived.length > 0 && (
        <details className="rounded-xl border border-line bg-panel p-4">
          <summary className="cursor-pointer text-[14px] font-medium">Show archived ({data.archived.length})</summary>
          <ul className="mt-3 space-y-3">
            {data.archived.map((d) => (
              <li key={d.id}><DscCard clientId={clientId} d={d} today={data.today} remindDays={data.remindDays} perms={perms} /></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function DscCard({ clientId, d, today, remindDays, perms }: {
  clientId: string; d: DscRecord; today: string; remindDays: number; perms: DscPerms;
}) {
  const status = expiryStatus(d.expiresOn, today, remindDays);
  const latest = d.custody[0] ?? null;
  const out = latest?.direction === "out";
  const live = !d.archivedAt;
  const headingId = useId();
  return (
    <Card className="p-5">
      <article aria-labelledby={headingId}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={headingId} className="break-words font-semibold">{d.holderName}</h3>
            <p className="mt-0.5 text-[13.5px] text-ink-2">
              {[dscClassLabel(d.dscClass), d.issuer].filter(Boolean).join(" · ") || "Class and issuer not recorded"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {live ? <Badge tone={status.tone}>{status.text}</Badge> : <Badge tone="muted">Archived</Badge>}
            <Badge tone={out ? "warn" : "muted"}>{custodyText(latest)}</Badge>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
          <dt className="text-ink-3">Expiry</dt><dd>{shortDate(d.expiresOn)}</dd>
          {d.tokenNote && <><dt className="text-ink-3">Token / notes</dt><dd className="break-words">{d.tokenNote}</dd></>}
          <dt className="text-ink-3">Password set</dt><dd>{new Date(d.passwordSetAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}</dd>
          {!live && d.archiveReason && <><dt className="text-ink-3">Archived</dt><dd className="break-words">{d.archiveReason}</dd></>}
        </dl>

        {live && perms.canReveal && <Reveal id={d.id} holder={d.holderName} />}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {live && perms.canCustody && (
            <Modal trigger={out ? "Received back" : "Give out"} triggerVariant="button"
              title={out ? `Received back: ${d.holderName}` : `Give out: ${d.holderName}`}
              triggerLabel={out ? `Record ${d.holderName}'s DSC as received back` : `Record ${d.holderName}'s DSC as given out`}>
              {(close) => <CustodyForm clientId={clientId} dscId={d.id} direction={out ? "in" : "out"}
                defaultName={out ? latest?.person_name ?? "" : ""} onDone={close} />}
            </Modal>
          )}
          {live && perms.canEdit && (
            <>
              <Modal trigger="Edit" triggerVariant="button" title={`Edit DSC: ${d.holderName}`} triggerLabel={`Edit ${d.holderName}'s DSC`}>
                {(close) => <DscForm clientId={clientId} existing={d} onDone={close} />}
              </Modal>
              <Modal trigger="Change password" triggerVariant="button" title={`Change password: ${d.holderName}`}
                triggerLabel={`Change the password of ${d.holderName}'s DSC`}>
                {(close) => <PasswordForm clientId={clientId} id={d.id} onDone={close} />}
              </Modal>
            </>
          )}
          {perms.canArchive && (live ? (
            <Modal trigger="Archive" triggerVariant="button" title={`Archive DSC: ${d.holderName}?`} triggerLabel={`Archive ${d.holderName}'s DSC`}>
              {(close) => <ArchiveForm clientId={clientId} id={d.id} onDone={close} />}
            </Modal>
          ) : <UnarchiveButton clientId={clientId} id={d.id} holder={d.holderName} />)}
        </div>

        {d.custody.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-[13.5px] font-medium text-accent">Custody log ({d.custody.length})</summary>
            <ol className="mt-2 space-y-1.5 text-[13.5px]">
              {d.custody.map((c, i) => (
                <li key={`${c.at}-${i}`} className="break-words">
                  <span className="font-medium">{c.direction === "out" ? "Given to" : "Received back from"} {c.person_name}</span>
                  {" "}on {shortDate(c.on_date)}
                  {c.actor && <span className="text-ink-3"> · recorded by {c.actor}</span>}
                  {c.note && <span className="block text-ink-2">{c.note}</span>}
                </li>
              ))}
            </ol>
          </details>
        )}
      </article>
    </Card>
  );
}

/** AC-7: one logged reveal per click; shown for 30 s with Copy, then hidden again. Never stored. */
export function Reveal({ id, holder }: { id: string; holder: string }) {
  const [shown, setShown] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const hide = (said = "Password hidden.") => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setShown(null);
    setLeft(0);
    setCopied(false);
    setAnnounce(said);
  };
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const reveal = () => start(async () => {
    setError(null);
    const r = await revealDscPassword({ id });
    if (!r.ok) { setError(r.error); return; }
    setShown(r.password);
    setLeft(REVEAL_SECONDS);
    setAnnounce(`Password shown for ${REVEAL_SECONDS} seconds.`);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) { hide(); return 0; }
        return s - 1;
      });
    }, 1000);
  });

  return (
    <div className="mt-3">
      {shown === null ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={reveal} aria-label={`Show the password of ${holder}'s DSC`}>
          {pending ? "Showing…" : "Show password"}
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-[9px] border border-line-2 bg-canvas px-3 py-2">
          <span className="text-[13px] text-ink-3">Password</span>
          <code data-testid="dsc-password" className="break-all font-mono text-[14px]">{shown}</code>
          <Button size="sm" variant="secondary" onClick={async () => {
            try { await navigator.clipboard.writeText(shown); setCopied(true); } catch { setCopied(false); }
          }}>{copied ? "Copied" : "Copy"}</Button>
          <Button size="sm" variant="secondary" onClick={() => hide()}>Hide</Button>
          <span className="text-[12.5px] text-ink-3" aria-hidden="true">Hides in {left} s</span>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {error && <p role="alert" className="mt-1 text-[13px] text-bad">{error}</p>}
    </div>
  );
}

function useSubmit<T extends { ok: boolean; error?: string; fieldErrors?: Fe }>(onDone: () => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Fe>({});
  const run = (fn: () => Promise<T>) => start(async () => {
    setError(null);
    setFe({});
    const r = await fn();
    if (!r.ok) { setError(r.error ?? "Couldn't save."); setFe(r.fieldErrors ?? {}); return; }
    onDone();
    router.refresh();
  });
  return { pending, error, fe, run };
}

function DscForm({ clientId, existing, onDone }: { clientId: string; existing?: DscRecord; onDone: () => void }) {
  const uid = useId();
  const { pending, error, fe, run } = useSubmit(onDone);
  const [showPw, setShowPw] = useState(false);
  const a = (f: string) => ({ "aria-invalid": !!fe[f], "aria-describedby": fe[f] ? `${uid}-${f}` : undefined });
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const get = (k: string) => (f.get(k) as string | null) ?? "";
      run(() => saveDsc({
        id: existing?.id, clientId, holderName: get("holderName"), expiresOn: get("expiresOn"),
        password: existing ? undefined : get("password"), dscClass: get("dscClass"), issuer: get("issuer"), tokenNote: get("tokenNote"),
      }));
    }}>
      <label className="block text-[13.5px] font-medium">Holder name
        <input name="holderName" required maxLength={120} defaultValue={existing?.holderName} className={inputCls} {...a("holderName")} />
      </label>
      <FieldError id={`${uid}-holderName`} message={fe.holderName} />
      <label className="block text-[13.5px] font-medium">Expiry date
        <input name="expiresOn" type="date" required defaultValue={existing?.expiresOn} className={inputCls} {...a("expiresOn")} />
      </label>
      <FieldError id={`${uid}-expiresOn`} message={fe.expiresOn} />
      {existing && <p className="text-[12.5px] text-ink-3">Renewed? Enter the new expiry date. To change the password, use Change password.</p>}
      {!existing && (
        <>
          <label className="block text-[13.5px] font-medium" htmlFor={`${uid}-pw`}>Token PIN / password</label>
          <div className="flex gap-2">
            <input id={`${uid}-pw`} name="password" type={showPw ? "text" : "password"} required maxLength={MAX_PASSWORD}
              autoComplete="new-password" spellCheck={false} className={inputCls} {...a("password")} />
            <Button type="button" size="sm" variant="secondary" className="mt-1" aria-pressed={showPw} onClick={() => setShowPw((s) => !s)}>
              {showPw ? "Hide" : "Show"}
            </Button>
          </div>
          <FieldError id={`${uid}-password`} message={fe.password} />
          <p className="text-[12.5px] text-ink-3">Stored encrypted. Every time someone shows it, that is recorded in Activity.</p>
        </>
      )}
      <label className="block text-[13.5px] font-medium">Class <span className="font-normal text-ink-3">(optional)</span>
        <select name="dscClass" defaultValue={existing?.dscClass ?? ""} className={inputCls} {...a("dscClass")}>
          <option value="">Not recorded</option>
          {DSC_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      <label className="block text-[13.5px] font-medium">Issuer <span className="font-normal text-ink-3">(optional)</span>
        <input name="issuer" maxLength={80} list={`${uid}-issuers`} defaultValue={existing?.issuer ?? ""} className={inputCls} {...a("issuer")} />
      </label>
      <datalist id={`${uid}-issuers`}>{DSC_ISSUERS.map((i) => <option key={i} value={i} />)}</datalist>
      <FieldError id={`${uid}-issuer`} message={fe.issuer} />
      <label className="block text-[13.5px] font-medium">Token serial / notes <span className="font-normal text-ink-3">(optional)</span>
        <textarea name="tokenNote" maxLength={200} rows={2} defaultValue={existing?.tokenNote ?? ""} className={inputCls} {...a("tokenNote")} />
      </label>
      <FieldError id={`${uid}-tokenNote`} message={fe.tokenNote} />
      {error && <p role="alert" className="text-[13.5px] text-bad">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : existing ? "Save" : "Add DSC"}</Button>
      </div>
    </form>
  );
}

function PasswordForm({ clientId, id, onDone }: { clientId: string; id: string; onDone: () => void }) {
  const uid = useId();
  const { pending, error, fe, run } = useSubmit(onDone);
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      run(() => changeDscPassword({ id, clientId, password: (f.get("password") as string) ?? "", confirm: (f.get("confirm") as string) ?? "" }));
    }}>
      <label className="block text-[13.5px] font-medium">New token PIN / password
        <input name="password" type="password" required maxLength={MAX_PASSWORD} autoComplete="new-password" spellCheck={false}
          className={inputCls} aria-invalid={!!fe.password} aria-describedby={fe.password ? `${uid}-pw` : undefined} />
      </label>
      <label className="block text-[13.5px] font-medium">Type it again
        <input name="confirm" type="password" required maxLength={MAX_PASSWORD} autoComplete="new-password" spellCheck={false} className={inputCls} />
      </label>
      <FieldError id={`${uid}-pw`} message={fe.password} />
      {error && !fe.password && <p role="alert" className="text-[13.5px] text-bad">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Change password"}</Button>
      </div>
    </form>
  );
}

function CustodyForm({ clientId, dscId, direction, defaultName, onDone }: {
  clientId: string; dscId: string; direction: "out" | "in"; defaultName: string; onDone: () => void;
}) {
  const uid = useId();
  const { pending, error, fe, run } = useSubmit(onDone);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const a = (f: string) => ({ "aria-invalid": !!fe[f], "aria-describedby": fe[f] ? `${uid}-${f}` : undefined });
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const get = (k: string) => (f.get(k) as string | null) ?? "";
      run(() => logDscCustody({ dscId, clientId, direction, personName: get("personName"), onDate: get("onDate"), note: get("note") }));
    }}>
      <label className="block text-[13.5px] font-medium">{direction === "out" ? "Given to" : "Received back from"}
        <input name="personName" required maxLength={120} defaultValue={defaultName} className={inputCls} {...a("personName")} />
      </label>
      <FieldError id={`${uid}-personName`} message={fe.personName} />
      <label className="block text-[13.5px] font-medium">Date
        <input name="onDate" type="date" required max={today} defaultValue={today} className={inputCls} {...a("onDate")} />
      </label>
      <FieldError id={`${uid}-onDate`} message={fe.onDate} />
      <label className="block text-[13.5px] font-medium">Note <span className="font-normal text-ink-3">(optional)</span>
        <input name="note" maxLength={200} className={inputCls} {...a("note")} />
      </label>
      <FieldError id={`${uid}-note`} message={fe.note} />
      {error && <p role="alert" className="text-[13.5px] text-bad">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : direction === "out" ? "Record given out" : "Record received back"}</Button>
      </div>
    </form>
  );
}

function ArchiveForm({ clientId, id, onDone }: { clientId: string; id: string; onDone: () => void }) {
  const uid = useId();
  const { pending, error, fe, run } = useSubmit(onDone);
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      run(() => archiveDsc({ id, clientId, reason: (f.get("reason") as string) ?? "" }));
    }}>
      <p className="text-[13.5px] text-ink-2">Archive a DSC the firm no longer manages. It leaves the list and Today; nothing is deleted, and it can be unarchived.</p>
      <label className="block text-[13.5px] font-medium">Reason
        <textarea name="reason" required maxLength={500} rows={2} className={inputCls}
          aria-invalid={!!fe.reason} aria-describedby={fe.reason ? `${uid}-reason` : undefined} />
      </label>
      <FieldError id={`${uid}-reason`} message={fe.reason} />
      {error && !fe.reason && <p role="alert" className="text-[13.5px] text-bad">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="danger" disabled={pending}>{pending ? "Archiving…" : "Archive DSC"}</Button>
      </div>
    </form>
  );
}

function UnarchiveButton({ clientId, id, holder }: { clientId: string; id: string; holder: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" variant="secondary" disabled={pending} aria-label={`Unarchive ${holder}'s DSC`} onClick={() => start(async () => {
        const r = await unarchiveDsc({ id, clientId });
        if (!r.ok) setError(r.error); else router.refresh();
      })}>{pending ? "Unarchiving…" : "Unarchive"}</Button>
      {error && <span role="alert" className="text-[13px] text-bad">{error}</span>}
    </span>
  );
}
