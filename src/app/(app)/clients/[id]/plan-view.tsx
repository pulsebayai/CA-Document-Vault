"use client";

import { useActionState, useEffect, useId, useState, useTransition } from "react";
import {
  addPlanType, assignGroup, disableGroup, enableGroup, pausePlanItem, resumePlanItem, savePlanType, setPlanTypeActive,
  setPlanTypeReminders, type PlanResult,
} from "@/lib/plan/actions";
import type { ClientPlan, PlanGroup, PlanPeriod, PlanType } from "@/lib/plan/queries";
import { allowedFrequencies, FREQUENCY_LABEL, scheduleSummary, type Frequency } from "@/lib/validation/catalogue";
import { periodKindFor } from "@/lib/validation/plan";
import { Badge, Button, Card, Switch } from "@/components/ui";
import { FieldError, inputCls, Modal, Offset } from "@/components/dialog";

type Props = {
  clientId: string; plan: ClientPlan; inchargeId: string;
  /** Staff+ on an open client: enable/disable, add/remove/restore types, schedule, reminders. */
  canEdit: boolean;
  /** Admin/Manager on an open client: pause/resume and assign staff (AC-20, S2). */
  canManage: boolean;
  /** Shown when the plan is read-only (Limited user). */
  note?: string;
};
type Staff = ClientPlan["staff"];

/** Client › Settings — the client's collection plan (spec 02 AC-19 … AC-21, mockup 11). */
export function PlanView({ clientId, plan, inchargeId, canEdit, canManage, note }: Props) {
  const nameOf = (id: string | null) => plan.staff.find((s) => s.id === id)?.name ?? null;
  return (
    <div className="space-y-4">
      {note && <p role="note" className="text-[13.5px] text-ink-2">{note}</p>}
      {plan.groups.length === 0 && (
        <Card className="px-6 py-8 text-center">
          <p className="font-medium">No document groups are collected for this client yet</p>
          <p className="mt-1 text-[13.5px] text-ink-2">{canEdit ? "Enable a group below — its document types are copied from the catalogue." : "Nothing to collect yet."}</p>
        </Card>
      )}
      {plan.groups.map((g) => (
        <GroupCard key={g.id} clientId={clientId} group={g} periods={plan.periods} staff={plan.staff}
          assigneeName={nameOf(g.assignedStaffId ?? inchargeId)} nameOf={nameOf} canEdit={canEdit} canManage={canManage} />
      ))}
      {plan.otherGroups.length > 0 && <OtherGroups clientId={clientId} groups={plan.otherGroups} canEdit={canEdit} />}
    </div>
  );
}

function useAct() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<PlanResult | null>(null);
  const run = (fn: () => Promise<PlanResult>) => start(async () => setResult(await fn()));
  return { pending, result, run };
}

function ResultLine({ result }: { result: PlanResult | null }) {
  if (!result || result.ok) return null;
  return <p role="alert" className="px-5 pb-3 text-[13.5px] text-bad">{result.error}</p>;
}

const monthYear = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso));

// ── Group ────────────────────────────────────────────────────────────────────
function GroupCard({ clientId, group, periods, staff, assigneeName, nameOf, canEdit, canManage }: {
  clientId: string; group: PlanGroup; periods: PlanPeriod[]; staff: Staff; assigneeName: string | null;
  nameOf: (id: string | null) => string | null; canEdit: boolean; canManage: boolean;
}) {
  const { pending, result, run } = useAct();
  const headingId = useId();
  const paused = group.state === "paused";
  const assignable = staff.filter((s) => s.active || s.id === group.assignedStaffId);
  return (
    <Card>
      <section aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3">
          <h3 id={headingId} className="font-semibold">{group.name}</h3>
          {canManage ? (
            <label className="flex items-center gap-2 text-[13.5px] text-ink-2">Assigned to
              <select value={group.assignedStaffId ?? ""} disabled={pending}
                onChange={(e) => run(() => assignGroup(group.id, e.target.value))}
                className="rounded-[8px] border border-line-2 bg-panel px-2 py-1 text-[13.5px] text-ink">
                {!group.assignedStaffId && <option value="">—</option>}
                {assignable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          ) : (
            <span className="text-[13.5px] text-ink-2">Assigned to <span className="text-ink">{assigneeName ?? "—"}</span></span>
          )}
          {paused && (
            <span className="flex items-center gap-2 text-[13px] text-ink-2">
              <Badge tone="muted">Paused{group.pausedAt ? ` since ${monthYear(group.pausedAt)}` : ""}</Badge>
              {group.remark && <span>{group.remark}</span>}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            {canManage && (paused
              ? <Button size="sm" variant="secondary" aria-label={`Resume ${group.name}`} disabled={pending} onClick={() => run(() => resumePlanItem("group", group.id))}>Resume</Button>
              : <PauseDialog kind="group" id={group.id} name={group.name} />)}
            <span className="flex items-center gap-2 text-[13.5px] text-ink-2"
              title={paused && !canManage ? "Paused by an Admin or Manager — only they can switch it off" : undefined}>Collected
              {/* A paused group can only be switched off by Admin/Manager: off → on would otherwise resume it (AC-20). */}
              <Switch checked label={`Collect ${group.name} for this client`} disabled={!canEdit || pending || (paused && !canManage)}
                onChange={() => run(() => disableGroup(clientId, group.docGroupId))} />
            </span>
          </div>
        </div>
        <ResultLine result={result} />
        <div className="relative overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <caption className="sr-only">{group.name} document types</caption>
            <thead className="text-[13px] text-ink-3">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Collected</th>
                <th scope="col" className="px-3 py-2 font-medium">Reminders</th>
                <th scope="col" className="px-3 py-2 font-medium">Active</th>
                <th scope="col" className="px-5 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {group.types.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-3 text-[13.5px] text-ink-3">No types in this group yet.</td></tr>
              )}
              {group.types.map((t) => (
                <TypeRow key={t.id} type={t} periods={periods} staff={staff} groupAssignee={assigneeName}
                  assigneeName={nameOf(t.assignedStaffId)} canEdit={canEdit} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && group.addable.length > 0 && (
          <div className="border-t border-line px-5 py-2.5">
            <AddTypeDialog clientId={clientId} group={group} />
          </div>
        )}
      </section>
    </Card>
  );
}

// ── Type row ─────────────────────────────────────────────────────────────────
function TypeRow({ type: t, periods, staff, groupAssignee, assigneeName, canEdit, canManage }: {
  type: PlanType; periods: PlanPeriod[]; staff: Staff; groupAssignee: string | null; assigneeName: string | null;
  canEdit: boolean; canManage: boolean;
}) {
  const { pending, result, run } = useAct();
  const removed = t.state === "removed";
  const paused = t.state === "paused";
  const summary = scheduleSummary({ ask_after_months: t.askAfterMonths, ask_day: t.askDay, overdue_after_months: t.overdueAfterMonths, overdue_day: t.overdueDay });
  return (
    <tr className={`border-t border-line align-top ${removed || paused ? "text-ink-3" : ""}`}>
      <td className="px-5 py-2.5">
        <span className={removed || paused ? "" : "font-medium"}>{t.name}</span>
        {t.proposed && <span className="ml-2"><Badge tone="accent">Proposed</Badge></span>}
        {assigneeName && <span className="block text-[12.5px] text-ink-3">Assigned to {assigneeName}</span>}
        {paused && <span className="block text-[12.5px]">Paused{t.pausedAt ? ` ${monthYear(t.pausedAt)}` : ""}{t.remark ? ` · ${t.remark}` : ""}</span>}
        {removed && <span className="block text-[12.5px]">Not collected for this client</span>}
        {result && !result.ok && <span role="alert" className="block text-[13px] text-bad">{result.error}</span>}
      </td>
      <td className="px-3 py-2.5">
        {FREQUENCY_LABEL[t.frequency]}
        {summary && !removed && <span className="block max-w-[34ch] text-[12.5px] text-ink-3">{summary}</span>}
      </td>
      <td className="px-3 py-2.5">
        <Switch checked={t.reminders} label={`Reminders for ${t.name}`}
          disabled={!canEdit || pending || t.state !== "active" || t.frequency === "as_needed"}
          onChange={(on) => run(() => setPlanTypeReminders(t.id, on))} />
      </td>
      <td className="px-3 py-2.5">
        <Switch checked={!removed} label={`Collect ${t.name} for this client`} disabled={!canEdit || pending || paused}
          onChange={(on) => run(() => setPlanTypeActive(t.id, on))} />
      </td>
      <td className="whitespace-nowrap px-5 py-2 text-right">
        <span className="inline-flex gap-2">
          {canManage && t.state === "active" && <PauseDialog kind="type" id={t.id} name={t.name} />}
          {canManage && paused && (
            <Button size="sm" variant="secondary" aria-label={`Resume ${t.name}`} disabled={pending} onClick={() => run(() => resumePlanItem("type", t.id))}>Resume</Button>
          )}
          {canEdit && !removed && <TypeDialog type={t} periods={periods} staff={staff} groupAssignee={groupAssignee} canManage={canManage} />}
        </span>
      </td>
    </tr>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────
function PauseDialog({ kind, id, name }: { kind: "group" | "type"; id: string; name: string }) {
  return (
    <Modal trigger="Pause" title={`Pause ${name}`} triggerVariant="button">
      {(close) => <PauseForm kind={kind} id={id} close={close} />}
    </Modal>
  );
}

function PauseForm({ kind, id, close }: { kind: "group" | "type"; id: string; close: () => void }) {
  const [remark, setRemark] = useState("");
  const { pending, result, run } = useAct();
  useEffect(() => { if (result?.ok) close(); }, [result, close]);
  const uid = useId();
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(() => pausePlanItem(kind, id, remark)); }}>
      <p className="text-[13.5px] text-ink-2">
        Nothing is asked for while {kind === "group" ? "the group is" : "this type is"} paused. Settings are kept; resume at any time.
      </p>
      <label className="block text-[13.5px] font-medium">Remark <span className="font-normal text-ink-3">(optional, e.g. why and until when)</span>
        <textarea value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={500} rows={2} className={inputCls}
          aria-invalid={!!(result && !result.ok && result.fieldErrors?.remark)} aria-describedby={`${uid}-remark`} />
      </label>
      <FieldError id={`${uid}-remark`} message={result && !result.ok ? result.fieldErrors?.remark : undefined} />
      {result && !result.ok && !result.fieldErrors && <p role="alert" className="text-[13.5px] text-bad">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Pausing…" : "Pause"}</Button>
      </div>
    </form>
  );
}

function AddTypeDialog({ clientId, group }: { clientId: string; group: PlanGroup }) {
  return (
    <Modal trigger={`+ Add type to ${group.name}`} title={`Add a type to ${group.name}`} triggerVariant="link">
      {(close) => <AddTypeForm clientId={clientId} group={group} close={close} />}
    </Modal>
  );
}

function AddTypeForm({ clientId, group, close }: { clientId: string; group: PlanGroup; close: () => void }) {
  const [docTypeId, setDocTypeId] = useState(group.addable[0]?.id ?? "");
  const { pending, result, run } = useAct();
  useEffect(() => { if (result?.ok) close(); }, [result, close]);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(() => addPlanType(clientId, docTypeId)); }}>
      <label className="block text-[13.5px] font-medium">Document type
        <select value={docTypeId} onChange={(e) => setDocTypeId(e.target.value)} className={inputCls}>
          {group.addable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <p className="text-[13px] text-ink-3">Uses the catalogue&apos;s schedule and reminders; you can change them for this client afterwards.</p>
      {result && !result.ok && <p role="alert" className="text-[13.5px] text-bad">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending || !docTypeId}>{pending ? "Adding…" : "Add type"}</Button>
      </div>
    </form>
  );
}

function TypeDialog(props: { type: PlanType; periods: PlanPeriod[]; staff: Staff; groupAssignee: string | null; canManage: boolean }) {
  return (
    <Modal trigger="Edit" title={`Edit ${props.type.name}`} triggerVariant="button">
      {(close) => <TypeForm {...props} close={close} />}
    </Modal>
  );
}

/** The period that contains today (IST), else the first one of that kind. */
function currentPeriodId(periods: PlanPeriod[], kind: PlanPeriod["kind"]): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const ofKind = periods.filter((p) => p.kind === kind);
  return (ofKind.find((p) => p.startDate <= today && today <= p.endDate) ?? ofKind[0])?.id ?? "";
}

function TypeForm({ type: t, periods, staff, groupAssignee, canManage, close }: {
  type: PlanType; periods: PlanPeriod[]; staff: Staff; groupAssignee: string | null; canManage: boolean; close: () => void;
}) {
  const [state, act, pending] = useActionState<PlanResult | null, FormData>(savePlanType, null);
  useEffect(() => { if (state?.ok) close(); }, [state, close]);
  const fe = state && !state.ok ? state.fieldErrors ?? {} : {};
  const uid = useId();
  const options = allowedFrequencies(t.periodKind);
  const [frequency, setFrequency] = useState<Frequency>(options.includes(t.frequency) ? t.frequency : options[0]);
  const kind = periodKindFor(frequency);
  const kindPeriods = kind ? periods.filter((p) => p.kind === kind) : [];
  const saved = t.startPeriodId && kindPeriods.some((p) => p.id === t.startPeriodId) ? t.startPeriodId : null;
  const err = (f: string) => ({ "aria-invalid": !!fe[f], "aria-describedby": fe[f] ? `${uid}-${f}` : undefined });
  const assignable = staff.filter((s) => s.active || s.id === t.assignedStaffId);

  return (
    <form action={act} className="space-y-4" noValidate>
      <input type="hidden" name="id" value={t.id} />
      <div>
        <label className="block text-[13.5px] font-medium">Collected
          <select name="frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className={inputCls} {...err("frequency")}>
            {options.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
          </select>
        </label>
        <FieldError id={`${uid}-frequency`} message={fe.frequency} />
      </div>
      {kind && (
        <>
          <div>
            {/* key: switching frequency re-picks the default period of the new kind. */}
            <label className="block text-[13.5px] font-medium">Collect from
              <select key={kind} name="startPeriodId" defaultValue={saved ?? currentPeriodId(periods, kind)} className={inputCls} {...err("startPeriodId")}>
                {kindPeriods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <FieldError id={`${uid}-startPeriodId`} message={fe.startPeriodId} />
          </div>
          <fieldset className="rounded-lg border border-line px-4 py-3">
            <legend className="px-1 text-[13.5px] font-medium">When to ask the client</legend>
            <p className="text-[13px] text-ink-3">Months after the period ends (0 = its last month, 1 = the next month) and the day of that month.</p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
              <Offset label="Ask" monthsName="askAfterMonths" dayName="askDay" months={t.askAfterMonths ?? 1} day={t.askDay ?? 1} fe={fe} uid={uid} />
              <Offset label="Overdue from" monthsName="overdueAfterMonths" dayName="overdueDay" months={t.overdueAfterMonths ?? 1} day={t.overdueDay ?? 10} fe={fe} uid={uid} />
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" name="reminders" defaultChecked={t.frequency === "as_needed" ? true : t.reminders} className="h-4 w-4 accent-accent" /> Reminders
          </label>
        </>
      )}
      {canManage && (
        <label className="block text-[13.5px] font-medium">Assigned to
          <select name="assignedStaffId" defaultValue={t.assignedStaffId ?? ""} className={inputCls}>
            <option value="">Same as the group{groupAssignee ? ` (${groupAssignee})` : ""}</option>
            {assignable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      <p className="text-[13px] text-ink-3">Changes apply to this client only; the catalogue is unchanged.</p>
      {state && !state.ok && <p role="alert" className="text-[13.5px] text-bad">{state.error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}

// ── Groups not collected ─────────────────────────────────────────────────────
function OtherGroups({ clientId, groups, canEdit }: { clientId: string; groups: ClientPlan["otherGroups"]; canEdit: boolean }) {
  const { pending, result, run } = useAct();
  const headingId = useId();
  return (
    <Card>
      <section aria-labelledby={headingId}>
        <div className="border-b border-line px-5 py-3">
          <h3 id={headingId} className="font-semibold">Other document groups</h3>
          <p className="text-[13.5px] text-ink-2">Not collected for this client.{canEdit ? " Enabling a group copies its types from the catalogue." : ""}</p>
        </div>
        <ResultLine result={result} />
        <ul>
          {groups.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 border-t border-line px-5 py-2.5 first:border-t-0">
              <span>{g.name}{g.wasEnabled && <span className="ml-2 text-[12.5px] text-ink-3">previously collected — settings kept</span>}</span>
              {canEdit && (
                <Button size="sm" variant="secondary" aria-label={`Enable ${g.name}`} disabled={pending}
                  onClick={() => run(() => enableGroup(clientId, g.id))}>Enable</Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
