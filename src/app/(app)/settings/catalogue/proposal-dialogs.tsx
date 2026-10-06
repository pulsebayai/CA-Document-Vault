"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  approveProposedType, editAndApproveType, mergeProposedType, previewDecision, rejectProposedType, searchMergeTargets,
  type Conflict, type DecisionCounts, type GovernanceResult, type MergeTarget, type PreviewResult,
} from "@/lib/catalogue/governance";
import type { ProposalItem } from "@/lib/catalogue/queries";
import {
  allowedFrequencies, FREQUENCY_LABEL, PERIOD_KINDS, PERIOD_LABEL, type Frequency, type PeriodKind,
} from "@/lib/validation/catalogue";
import { Button } from "@/components/ui";
import { FieldError, inputCls, Modal, Offset } from "@/components/dialog";

// Feature 05 step 4 — the four decisions on a proposed type (spec AC-2 … AC-12, mockup 05 + agreed deviation:
// "Edit & approve" as a link-button). Each dialog shows what will happen (AC-8), handles loading / error / stale
// ("Already decided", AC-11) and closes on success; the server actions refresh the page.

export type GroupOption = { id: string; name: string };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** AC-8: the preview lines, from the database's own numbers. */
export function previewLines(action: "approve" | "merge", c: DecisionCounts, item: { name: string; clientCount: number }, targetName?: string): string[] {
  const lines: string[] = [];
  if (action === "merge") {
    lines.push(`${plural(c.documents, "document")} on ${plural(c.clients, "client")} move to ${targetName}.`);
    lines.push("Review and dispatch states stay.");
    if (c.planAdded > 0) lines.push(`${targetName} is added to ${plural(c.planAdded, "client’s plan", "clients’ plans")}.`);
  } else {
    lines.push(`“${item.name}” becomes an approved type, offered for every client.`);
    if (item.clientCount > 1) lines.push(`The proposals for the other ${plural(item.clientCount - 1, "client")} are merged into it.`);
    lines.push(`${plural(c.documents, "document stays", "documents stay")} filed under it; review and dispatch states stay.`);
  }
  if (c.received > 0) lines.push(`${plural(c.received, "document")} will count as received for ${c.received === 1 ? "its expected item" : "their expected items"}.`);
  return lines;
}

function usePreview(load: (() => Promise<PreviewResult>) | null, deps: unknown[]) {
  // The status is derived from which request the stored result belongs to, so the effect only sets state
  // when a request finishes (no synchronous setState in the effect).
  const [attempt, setAttempt] = useState(0);
  const key = load ? JSON.stringify([...deps, attempt]) : null;
  const [done, setDone] = useState<{ key: string; result: PreviewResult } | null>(null);
  useEffect(() => {
    if (!load || !key) return;
    let live = true;
    load().then((result) => { if (live) setDone({ key, result }); },
      () => { if (live) setDone({ key, result: { ok: false, error: "Couldn't load the preview.", stale: false } }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const status: "idle" | "loading" | "done" = !key ? "idle" : done?.key === key ? "done" : "loading";
  return { status, result: status === "done" ? done!.result : undefined, retry: () => setAttempt((a) => a + 1) };
}

function PreviewBox({ preview, lines }: { preview: ReturnType<typeof usePreview>; lines: (c: DecisionCounts) => string[] }) {
  if (preview.status === "idle") return null;
  if (preview.status === "loading") return <p role="status" className="text-[13.5px] text-ink-2">Working out what will happen…</p>;
  const r = preview.result!;
  if (!r.ok) {
    return (
      <div role="alert" className="text-[13.5px] text-bad">
        {r.error} {!r.stale && <button type="button" className="ml-1 font-medium text-accent hover:underline" onClick={preview.retry}>Try again</button>}
      </div>
    );
  }
  if (r.conflicts.length) return <ConflictList conflicts={r.conflicts} />;
  return (
    <ul aria-label="What will happen" className="list-disc space-y-1 rounded-lg bg-canvas py-3 pl-8 pr-4 text-[13.5px]">
      {lines(r.counts).map((l) => <li key={l}>{l}</li>)}
    </ul>
  );
}

function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-[13.5px]">
      <p className="font-medium text-bad">
        {plural(conflicts.length, "document is", "documents are")} filed for a period this type can&apos;t hold. Nothing will move.
      </p>
      <ul aria-label="Documents that don't fit" className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {conflicts.map((c) => <li key={c.documentId}><Link href={`/documents/${c.documentId}`} className="text-accent hover:underline">{c.docCode}</Link></li>)}
      </ul>
    </div>
  );
}

/** Shared footer: error / stale message, Cancel + the decision button. */
function Footer({ result, pending, close, submit, label, disabled }: {
  result: GovernanceResult | null; pending: boolean; close: () => void; submit: () => void; label: string; disabled?: boolean;
}) {
  const failed = result && !result.ok ? result : null;
  return (
    <>
      {failed && !failed.conflicts?.length && <p role="alert" className="text-[13.5px] text-bad">{failed.error}</p>}
      {failed?.conflicts?.length ? <ConflictList conflicts={failed.conflicts} /> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={close}>{failed?.stale ? "Close" : "Cancel"}</Button>
        {!failed?.stale && <Button type="button" disabled={pending || disabled} onClick={submit}>{pending ? "Saving…" : label}</Button>}
      </div>
    </>
  );
}

/** Refreshes the page once the dialog closes (Close, Esc or Cancel) if it saw a stale decision, so the
 *  "Already decided by <name>" message stays readable until then (AC-11; pre-PR review I-2). */
const previewStale = (p: ReturnType<typeof usePreview>) => p.status === "done" && !p.result!.ok && p.result!.stale;

function useRefreshOnClose(stale: boolean) {
  const router = useRouter();
  const seen = useRef(false);
  useEffect(() => { if (stale) seen.current = true; }, [stale]);
  useEffect(() => () => { if (seen.current) router.refresh(); }, [router]);
}

function useDecision(close: () => void, previewStale = false) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<GovernanceResult | null>(null);
  useRefreshOnClose(previewStale || (!!result && !result.ok && result.stale));
  const run = (fn: () => Promise<GovernanceResult>) => start(async () => {
    const r = await fn();
    setResult(r);
    if (r.ok) { close(); router.refresh(); }
  });
  return { pending, result, run };
}

function CommentField({ value, onChange, error, label = "Comment", required = false }: {
  value: string; onChange: (v: string) => void; error?: string; label?: string; required?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-[13.5px] font-medium">
        {label} {!required && <span className="font-normal text-ink-3">(optional — kept on the type)</span>}
      </label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={2} maxLength={500} required={required}
        className={inputCls} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} />
      <FieldError id={`${id}-err`} message={error} />
    </div>
  );
}

// ── Approve (AC-2, AC-8) ─────────────────────────────────────────────────────
export function ApproveDialog({ item }: { item: ProposalItem }) {
  return (
    <Modal trigger="Approve" triggerVariant="primary" title={`Approve “${item.name}”`} triggerLabel={`Approve ${item.name}`}>
      {(close) => <ApproveForm item={item} close={close} />}
    </Modal>
  );
}

function ApproveForm({ item, close }: { item: ProposalItem; close: () => void }) {
  const [comment, setComment] = useState("");
  const preview = usePreview(() => previewDecision({ action: "approve", typeId: item.typeId }), [item.typeId]);
  const { pending, result, run } = useDecision(close, previewStale(preview));
  const fe = result && !result.ok ? result.fieldErrors ?? {} : {};
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] text-ink-2">{item.groupName} · proposed for {plural(item.clientCount, "client")}</p>
      <PreviewBox preview={preview} lines={(c) => previewLines("approve", c, item)} />
      <CommentField value={comment} onChange={setComment} error={fe.comment} />
      <Footer result={result} pending={pending} close={close} label="Approve"
        disabled={preview.status !== "done" || !preview.result?.ok}
        submit={() => run(() => approveProposedType({ typeId: item.typeId, comment }))} />
    </div>
  );
}

// ── Edit & approve (AC-3, AC-4): 02's add-type fields, pre-filled ─────────────
export function EditApproveDialog({ item, groups }: { item: ProposalItem; groups: GroupOption[] }) {
  return (
    <Modal trigger="Edit & approve" triggerVariant="link" title={`Edit & approve “${item.name}”`} triggerLabel={`Edit & approve ${item.name}`}>
      {(close) => <EditApproveForm item={item} groups={groups} close={close} />}
    </Modal>
  );
}

function EditApproveForm({ item, groups, close }: { item: ProposalItem; groups: GroupOption[]; close: () => void }) {
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [periodKind, setPeriodKind] = useState<PeriodKind>("none");
  const options = allowedFrequencies(periodKind);
  const [frequency, setFrequency] = useState<Frequency>("as_needed");
  const freq = options.includes(frequency) ? frequency : options[0];
  const scheduled = freq !== "as_needed";
  const [comment, setComment] = useState("");
  const { pending, result, run } = useDecision(close);
  const fe = result && !result.ok ? result.fieldErrors ?? {} : {};
  const err = (f: string) => ({ "aria-invalid": !!fe[f], "aria-describedby": fe[f] ? `${uid}-${f}` : undefined });

  const submit = () => {
    const d = new FormData(form.current!);
    const edits = Object.fromEntries(["name", "aliases", "groupId", "periodKind", "frequency", "askAfterMonths", "askDay", "overdueAfterMonths", "overdueDay", "reminders"]
      .map((k) => [k, d.get(k) ?? undefined]));
    run(() => editAndApproveType({ typeId: item.typeId, edits, comment }));
  };

  return (
    <form ref={form} className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div>
        <label className="block text-[13.5px] font-medium">Name
          <input name="name" defaultValue={item.name} required maxLength={120} className={inputCls} {...err("name")} />
        </label>
        <FieldError id={`${uid}-name`} message={fe.name} />
        <p className="mt-1 text-[13px] text-ink-3">Renamed? The proposed name is kept as an alias, so staff still find it.</p>
      </div>
      <div>
        <label className="block text-[13.5px] font-medium">Group
          <select name="groupId" defaultValue={item.groupId} className={inputCls} {...err("groupId")}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <FieldError id={`${uid}-groupId`} message={fe.groupId} />
      </div>
      <label className="block text-[13.5px] font-medium">Period it covers
        <select name="periodKind" value={periodKind} onChange={(e) => setPeriodKind(e.target.value as PeriodKind)} className={inputCls} {...err("periodKind")}>
          {PERIOD_KINDS.map((k) => <option key={k} value={k}>{PERIOD_LABEL[k]}</option>)}
        </select>
      </label>
      <div>
        <label className="block text-[13.5px] font-medium">Default collection
          <select name="frequency" value={freq} onChange={(e) => setFrequency(e.target.value as Frequency)} className={inputCls} {...err("frequency")}>
            {options.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
          </select>
        </label>
        <FieldError id={`${uid}-frequency`} message={fe.frequency} />
        {scheduled && <p className="mt-1 text-[13px] text-ink-3">The proposing clients get this schedule from the earliest open period; other clients are unchanged.</p>}
      </div>
      {scheduled && (
        <fieldset className="rounded-lg border border-line px-4 py-3">
          <legend className="px-1 text-[13.5px] font-medium">When to ask the client</legend>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-2">
            <Offset label="Ask" monthsName="askAfterMonths" dayName="askDay" months={1} day={1} fe={fe} uid={uid} />
            <Offset label="Overdue from" monthsName="overdueAfterMonths" dayName="overdueDay" months={1} day={10} fe={fe} uid={uid} />
          </div>
        </fieldset>
      )}
      {scheduled && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <input type="checkbox" name="reminders" defaultChecked className="h-4 w-4 accent-accent" /> Reminders
        </label>
      )}
      <div>
        <label className="block text-[13.5px] font-medium">Also known as <span className="font-normal text-ink-3">(optional, separate with commas)</span>
          <input name="aliases" className={inputCls} {...err("aliases")} />
        </label>
        <FieldError id={`${uid}-aliases`} message={fe.aliases} />
      </div>
      <CommentField value={comment} onChange={setComment} error={fe.comment} />
      <Footer result={result} pending={pending} close={close} label="Approve" submit={submit} />
    </form>
  );
}

// ── Merge into… (AC-5 … AC-8) ────────────────────────────────────────────────
export function MergeDialog({ item }: { item: ProposalItem }) {
  return (
    <Modal trigger="Merge into…" triggerVariant="button" title={`Merge “${item.name}” into an approved type`} triggerLabel={`Merge into… ${item.name}`}>
      {(close) => <MergeForm item={item} close={close} />}
    </Modal>
  );
}

function MergeForm({ item, close }: { item: ProposalItem; close: () => void }) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<MergeTarget[] | null>(null);
  const [target, setTarget] = useState<MergeTarget | null>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      searchMergeTargets({ typeId: item.typeId, query }).then((r) => { if (live) setTargets(r); }, () => { if (live) setTargets([]); });
    }, query ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [item.typeId, query]);

  const preview = usePreview(target ? () => previewDecision({ action: "merge", typeId: item.typeId, targetId: target.id }) : null, [item.typeId, target?.id]);
  const { pending, result, run } = useDecision(close, previewStale(preview));
  const fe = result && !result.ok ? result.fieldErrors ?? {} : {};
  const conflicting = preview.status === "done" && preview.result?.ok && preview.result.conflicts.length > 0;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`${uid}-q`} className="block text-[13.5px] font-medium">Find the approved type</label>
        <input id={`${uid}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={item.name}
          className={inputCls} aria-describedby={`${uid}-hint`} />
        <p id={`${uid}-hint`} className="mt-1 text-[13px] text-ink-3">Closest names and aliases first.</p>
      </div>
      {targets === null ? (
        <p role="status" className="text-[13.5px] text-ink-2">Finding types…</p>
      ) : targets.length === 0 ? (
        <p className="text-[13.5px] text-ink-3">No approved type matches. Try another name.</p>
      ) : (
        <fieldset>
          <legend className="sr-only">Approved types</legend>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {targets.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-canvas">
                  <input type="radio" name={`${uid}-target`} value={t.id} checked={target?.id === t.id} onChange={() => setTarget(t)} className="accent-accent" />
                  <span className="font-medium">{t.name}</span> <span className="text-ink-3">{t.groupName}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <FieldError id={`${uid}-target-err`} message={fe.targetId} />
      <PreviewBox preview={preview} lines={(c) => previewLines("merge", c, item, target?.name)} />
      <CommentField value={comment} onChange={setComment} error={fe.comment} />
      <Footer result={result} pending={pending} close={close} label="Merge"
        disabled={!target || preview.status !== "done" || !preview.result?.ok || conflicting}
        submit={() => target && run(() => mergeProposedType({ typeId: item.typeId, targetId: target.id, comment }))} />
    </div>
  );
}

// ── Reject (AC-9) ────────────────────────────────────────────────────────────
export function RejectDialog({ item }: { item: ProposalItem }) {
  const hintId = useId();
  if (item.documentCount > 0) {
    return (
      <span className="inline-flex items-center gap-2">
        <Button size="sm" variant="danger" disabled aria-describedby={hintId}>Reject</Button>
        <span id={hintId} className="text-[13px] text-ink-3">{plural(item.documentCount, "document uses", "documents use")} this type. Merge it into an approved type instead.</span>
      </span>
    );
  }
  return (
    <Modal trigger="Reject" triggerVariant="button" title={`Reject “${item.name}”`} triggerLabel={`Reject ${item.name}`}>
      {(close) => <RejectForm item={item} close={close} />}
    </Modal>
  );
}

function RejectForm({ item, close }: { item: ProposalItem; close: () => void }) {
  const [reason, setReason] = useState("");
  const { pending, result, run } = useDecision(close);
  const fe = result && !result.ok ? result.fieldErrors ?? {} : {};
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] text-ink-2">
        The type is retired and removed from {plural(item.clientCount, "client’s plan", "clients’ plans")}. {item.proposedBy.length > 1 ? "The proposers see" : "The proposer sees"} the reason.
      </p>
      <CommentField label="Reason" required value={reason} onChange={setReason} error={fe.reason} />
      <Footer result={result} pending={pending} close={close} label="Reject"
        submit={() => run(() => rejectProposedType({ typeId: item.typeId, reason }))} />
    </div>
  );
}
