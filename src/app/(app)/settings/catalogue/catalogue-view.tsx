"use client";

import { useActionState, useEffect, useId, useState, useTransition } from "react";
import {
  addFinancialYear, moveGroup, saveDocGroup, saveDocType, setGroupEnabledForNew, setTypeReminders, type CatalogueResult,
} from "@/lib/catalogue/actions";
import type { Catalogue, CatalogueGroup, CatalogueType, FinancialYearRow } from "@/lib/catalogue/queries";
import {
  allowedFrequencies, FREQUENCY_LABEL, PERIOD_KINDS, PERIOD_LABEL, scheduleSummary, type DocSource, type Frequency, type PeriodKind,
} from "@/lib/validation/catalogue";
import { Badge, Button, Card, Switch } from "@/components/ui";
import { FieldError, inputCls, Modal, Offset } from "@/components/dialog";

type Props = { catalogue: Catalogue; canEdit: boolean; canAddFy: boolean };

/** Settings › Document catalogue (mockup 05, minus "Proposed by staff" — feature 05). Spec 02 AC-1…AC-6. */
export function CatalogueView({ catalogue, canEdit, canAddFy }: Props) {
  const activeGroups = catalogue.groups.filter((g) => g.active);
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Document catalogue</h2>
        <p className="mt-0.5 max-w-[70ch] text-[13.5px] text-ink-2">
          The documents the firm needs from clients, with when to ask for them. Schedules count from the end of each period.{" "}
          <strong className="font-medium text-ink">Existing clients keep their own schedule</strong> — changes here apply when a group is next enabled for a client.
        </p>
        {!canEdit && <p role="note" className="mt-2 text-[13.5px] text-ink-2">You can view the catalogue. An Admin or Manager can change it.</p>}
      </div>

      {catalogue.groups.length === 0 && (
        <Card className="px-6 py-10 text-center"><p className="font-medium">No document groups yet</p></Card>
      )}
      {catalogue.groups.map((g) => (
        <GroupCard key={g.id} group={g} canEdit={canEdit}
          first={g.id === activeGroups[0]?.id} last={g.id === activeGroups[activeGroups.length - 1]?.id} />
      ))}
      {canEdit && <GroupDialog trigger="+ Add group" />}

      <FirmRecords records={catalogue.firmRecords} groups={activeGroups} canEdit={canEdit} />
      <Years years={catalogue.years} canAddFy={canAddFy} />
    </div>
  );
}

// ── Inline actions (switches, reorder) ───────────────────────────────────────
function useInline() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<CatalogueResult>) => start(async () => {
    const r = await fn();
    setError(r.ok ? null : r.error);
  });
  return { pending, error, run };
}

function InlineError({ error }: { error: string | null }) {
  return error ? <p role="alert" className="px-5 pb-3 text-[13px] text-bad">{error}</p> : null;
}

// ── Groups ────────────────────────────────────────────────────────────────────
function GroupCard({ group, canEdit, first, last }: { group: CatalogueGroup; canEdit: boolean; first: boolean; last: boolean }) {
  const { pending, error, run } = useInline();
  const headingId = useId();
  return (
    <Card>
      <section aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <h3 id={headingId} className={`font-semibold ${group.active ? "" : "text-ink-3"}`}>{group.name}</h3>
          {!group.active && <Badge tone="muted">Inactive</Badge>}
          <div className="ml-auto flex items-center gap-2">
            {canEdit && group.active && (
              <>
                <Button size="sm" variant="secondary" aria-label={`Move ${group.name} up`} disabled={pending || first}
                  onClick={() => run(() => moveGroup(group.id, "up"))}>↑</Button>
                <Button size="sm" variant="secondary" aria-label={`Move ${group.name} down`} disabled={pending || last}
                  onClick={() => run(() => moveGroup(group.id, "down"))}>↓</Button>
              </>
            )}
            {canEdit && <GroupDialog group={group} trigger="Edit group" />}
            {group.active && (
              <span className="flex items-center gap-2 text-[13px] text-ink-2">
                <span aria-hidden>Enabled for new clients</span>
                <Switch checked={group.enabledForNewClients} label={`${group.name}: enabled for new clients`}
                  disabled={!canEdit || pending} onChange={(on) => run(() => setGroupEnabledForNew(group.id, on))} />
              </span>
            )}
          </div>
        </div>
        <InlineError error={error} />
        {group.active && (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <caption className="sr-only">{group.name} document types</caption>
              <thead className="text-[13px] text-ink-3">
                <tr className="border-b border-line">
                  <th scope="col" className="px-5 py-2.5 font-normal">Type</th>
                  <th scope="col" className="px-3 py-2.5 font-normal">Default collection</th>
                  <th scope="col" className="px-3 py-2.5 font-normal">Reminders</th>
                  <th scope="col" className="px-3 py-2.5 font-normal">Used by</th>
                  {canEdit && <th scope="col" className="px-5 py-2.5 font-normal"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {group.types.length === 0 && (
                  <tr><td colSpan={canEdit ? 5 : 4} className="px-5 py-4 text-[13.5px] text-ink-3">No types in this group yet.</td></tr>
                )}
                {group.types.map((t) => <TypeRow key={t.id} type={t} canEdit={canEdit} />)}
              </tbody>
            </table>
          </div>
        )}
        {canEdit && group.active && (
          <div className="border-t border-line px-5 py-2.5">
            <TypeDialog source="client" groups={[group]} trigger={`+ Add type to ${group.name}`} />
          </div>
        )}
      </section>
    </Card>
  );
}

function TypeRow({ type: t, canEdit }: { type: CatalogueType; canEdit: boolean }) {
  const { pending, error, run } = useInline();
  const scheduled = t.defaultFrequency !== "as_needed";
  return (
    <tr className="border-b border-line align-top last:border-0">
      <th scope="row" className="px-5 py-3 text-left font-normal">
        <span className={`font-medium ${t.active ? "" : "text-ink-3"}`}>{t.name}</span>
        {!t.active && <span className="ml-2"><Badge tone="muted">Inactive</Badge></span>}
        {(t.usedFor || t.aliases.length > 0) && (
          <span className="mt-0.5 block text-[13px] text-ink-3">
            {t.usedFor && <>Used for: {t.usedFor}</>}
            {t.usedFor && t.aliases.length > 0 && " · "}
            {t.aliases.length > 0 && <>Also: {t.aliases.join(", ")}</>}
          </span>
        )}
        {error && <span role="alert" className="mt-1 block text-[13px] text-bad">{error}</span>}
      </th>
      <td className="px-3 py-3 text-[13.5px]">
        {FREQUENCY_LABEL[t.defaultFrequency]}
        {scheduled && <span className="mt-0.5 block text-[13px] text-ink-3">{scheduleSummary({
          ask_after_months: t.askAfterMonths, ask_day: t.askDay, overdue_after_months: t.overdueAfterMonths, overdue_day: t.overdueDay,
        })}</span>}
      </td>
      <td className="px-3 py-3">
        <Switch checked={t.reminders} label={`Reminders for ${t.name}`} disabled={!canEdit || !scheduled || pending}
          onChange={(on) => run(() => setTypeReminders(t.id, on))} />
      </td>
      <td className="px-3 py-3 text-[13.5px] text-ink-2">{t.usedBy} {t.usedBy === 1 ? "client" : "clients"}</td>
      {canEdit && <td className="px-5 py-3 text-right"><TypeDialog source="client" type={t} trigger="Edit" /></td>}
    </tr>
  );
}

// ── Firm records ─────────────────────────────────────────────────────────────
function FirmRecords({ records, groups, canEdit }: { records: Catalogue["firmRecords"]; groups: CatalogueGroup[]; canEdit: boolean }) {
  return (
    <Card>
      <section aria-labelledby="firm-records">
        <div className="border-b border-line px-5 py-3">
          <h3 id="firm-records" className="font-semibold">Firm records</h3>
          <p className="mt-0.5 text-[13px] text-ink-2">Returns, acknowledgements and other records the firm produces. Filed and searched like any document; never asked from clients, so they have no schedule or reminders.</p>
        </div>
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <caption className="sr-only">Firm records</caption>
            <thead className="text-[13px] text-ink-3">
              <tr className="border-b border-line">
                <th scope="col" className="px-5 py-2.5 font-normal">Record</th>
                <th scope="col" className="px-3 py-2.5 font-normal">Group</th>
                <th scope="col" className="px-3 py-2.5 font-normal">Also known as</th>
                {canEdit && <th scope="col" className="px-5 py-2.5 font-normal"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && <tr><td colSpan={canEdit ? 4 : 3} className="px-5 py-4 text-[13.5px] text-ink-3">No firm records yet.</td></tr>}
              {records.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-5 py-3 text-left font-medium">
                    <span className={r.active ? "" : "text-ink-3"}>{r.name}</span>
                    {!r.active && <span className="ml-2"><Badge tone="muted">Inactive</Badge></span>}
                  </th>
                  <td className="px-3 py-3 text-[13.5px] text-ink-2">{r.groupName}</td>
                  <td className="px-3 py-3 text-[13.5px] text-ink-2">{r.aliases.join(", ")}</td>
                  {canEdit && <td className="px-5 py-3 text-right"><TypeDialog source="firm" type={r} trigger="Edit" /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && groups.length > 0 && (
          <div className="border-t border-line px-5 py-2.5"><TypeDialog source="firm" groups={groups} trigger="+ Add firm record" /></div>
        )}
      </section>
    </Card>
  );
}

// ── Financial years (AC-5) ───────────────────────────────────────────────────
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function Years({ years, canAddFy }: { years: FinancialYearRow[]; canAddFy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<CatalogueResult | null>(null);
  const last = years[years.length - 1];
  const nextCode = last ? `${Number(last.code.slice(0, 4)) + 1}-${String((Number(last.code.slice(0, 4)) + 2) % 100).padStart(2, "0")}` : null;
  return (
    <Card>
      <section aria-labelledby="fys" className="px-5 py-4">
        <h3 id="fys" className="font-semibold">Financial years</h3>
        <p className="mt-0.5 text-[13px] text-ink-2">Each year has 12 months, 4 quarters (Q1 = Apr–Jun) and the year itself.</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {years.map((y) => (
            <li key={y.id} className="rounded-lg border border-line px-3 py-1.5 text-[13.5px]">
              <span className="font-medium">FY {y.code}</span> <span className="text-ink-3">· {fmt(y.startDate)} – {fmt(y.endDate)}</span>
            </li>
          ))}
        </ul>
        {canAddFy && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!confirming ? (
              <Button size="sm" variant="secondary" onClick={() => { setResult(null); setConfirming(true); }}>Add next financial year</Button>
            ) : (
              <>
                <span className="text-[13.5px]">Add FY {nextCode ?? "for this year"}? This can&apos;t be undone.</span>
                <Button size="sm" disabled={pending} onClick={() => start(async () => { setResult(await addFinancialYear()); setConfirming(false); })}>
                  {pending ? "Adding…" : `Add FY ${nextCode ?? ""}`.trim()}
                </Button>
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>Cancel</Button>
              </>
            )}
            {result && <span role={result.ok ? "status" : "alert"} className={`text-[13px] ${result.ok ? "text-ok" : "text-bad"}`}>{result.ok ? result.message : result.error}</span>}
          </div>
        )}
      </section>
    </Card>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────
function useSaved(state: CatalogueResult | null, close: () => void) {
  useEffect(() => { if (state?.ok) close(); }, [state, close]);
}

function GroupDialog({ group, trigger }: { group?: CatalogueGroup; trigger: string }) {
  return (
    <Modal trigger={trigger} title={group ? `Edit group ${group.name}` : "Add a group"} triggerVariant={group ? "button" : "link"}>
      {(close) => <GroupForm group={group} close={close} />}
    </Modal>
  );
}

function GroupForm({ group, close }: { group?: CatalogueGroup; close: () => void }) {
  const [state, act, pending] = useActionState<CatalogueResult | null, FormData>(saveDocGroup, null);
  useSaved(state, close);
  const fe = state && !state.ok ? state.fieldErrors ?? {} : {};
  return (
    <form action={act} className="space-y-4" noValidate>
      {group && <input type="hidden" name="id" value={group.id} />}
      <label className="block text-[13.5px] font-medium">Group name
        <input name="name" defaultValue={group?.name} required maxLength={80} className={inputCls}
          aria-invalid={!!fe.name} aria-describedby={fe.name ? "group-name-err" : undefined} />
      </label>
      <FieldError id="group-name-err" message={fe.name} />
      {group && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <input type="checkbox" name="active" defaultChecked={group.active} className="h-4 w-4 accent-accent" />
          Active <span className="text-ink-3">(inactive groups can&apos;t be enabled for clients; existing clients keep theirs)</span>
        </label>
      )}
      <FormFooter state={state} pending={pending} close={close} />
    </form>
  );
}

function FormFooter({ state, pending, close }: { state: CatalogueResult | null; pending: boolean; close: () => void }) {
  return (
    <>
      {state && !state.ok && <p role="alert" className="text-[13.5px] text-bad">{state.error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </>
  );
}

function TypeDialog({ source, type, groups, trigger }: { source: DocSource; type?: CatalogueType; groups?: CatalogueGroup[]; trigger: string }) {
  const noun = source === "firm" ? "firm record" : "document type";
  const title = type ? `Edit ${type.name}` : groups?.length === 1 && source === "client" ? `Add a type to ${groups[0].name}` : `Add a ${noun}`;
  return (
    <Modal trigger={trigger} title={title} triggerVariant={type ? "button" : "link"}>
      {(close) => <TypeForm source={source} type={type} groups={groups ?? []} close={close} />}
    </Modal>
  );
}

function TypeForm({ source, type, groups, close }: { source: DocSource; type?: CatalogueType; groups: CatalogueGroup[]; close: () => void }) {
  const [state, act, pending] = useActionState<CatalogueResult | null, FormData>(saveDocType, null);
  useSaved(state, close);
  const fe = state && !state.ok ? state.fieldErrors ?? {} : {};
  const uid = useId();
  const [periodKind, setPeriodKind] = useState<PeriodKind>(type?.periodKind ?? "month");
  const options = allowedFrequencies(periodKind);
  const [frequency, setFrequency] = useState<Frequency>(type?.defaultFrequency ?? (source === "client" ? "monthly" : "as_needed"));
  const freq = options.includes(frequency) ? frequency : options[0];
  const scheduled = source === "client" && freq !== "as_needed";
  const err = (f: string) => ({ "aria-invalid": !!fe[f], "aria-describedby": fe[f] ? `${uid}-${f}` : undefined });

  return (
    <form action={act} className="space-y-4" noValidate>
      {type ? <input type="hidden" name="id" value={type.id} /> : <input type="hidden" name="source" value={source} />}
      {!type && groups.length === 1 && <input type="hidden" name="groupId" value={groups[0].id} />}
      {!type && groups.length > 1 && (
        <div>
          <label className="block text-[13.5px] font-medium">Group
            <select name="groupId" className={inputCls} {...err("groupId")}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <FieldError id={`${uid}-groupId`} message={fe.groupId} />
        </div>
      )}
      <div>
        <label className="block text-[13.5px] font-medium">Name
          <input name="name" defaultValue={type?.name} required maxLength={120} className={inputCls} {...err("name")} />
        </label>
        <FieldError id={`${uid}-name`} message={fe.name} />
        {source === "client" && <p className="mt-1 text-[13px] text-ink-3">Name it after what the client hands over, e.g. “Bank statement”.</p>}
      </div>
      {!type ? (
        <label className="block text-[13.5px] font-medium">Period it covers
          <select name="periodKind" value={periodKind} onChange={(e) => setPeriodKind(e.target.value as PeriodKind)} className={inputCls} {...err("periodKind")}>
            {PERIOD_KINDS.map((k) => <option key={k} value={k}>{PERIOD_LABEL[k]}</option>)}
          </select>
        </label>
      ) : (
        <p className="text-[13.5px] text-ink-2">Period it covers: {PERIOD_LABEL[type.periodKind]}</p>
      )}
      {source === "client" && (
        <>
          <label className="block text-[13.5px] font-medium">Default collection
            <select name="frequency" value={freq} onChange={(e) => setFrequency(e.target.value as Frequency)} className={inputCls} {...err("frequency")}>
              {options.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
            </select>
          </label>
          <FieldError id={`${uid}-frequency`} message={fe.frequency} />
          {scheduled && (
            <fieldset className="rounded-lg border border-line px-4 py-3">
              <legend className="px-1 text-[13.5px] font-medium">When to ask the client</legend>
              <p className="text-[13px] text-ink-3">Months after the period ends (0 = its last month, 1 = the next month) and the day of that month.</p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                <Offset label="Ask" monthsName="askAfterMonths" dayName="askDay" months={type?.askAfterMonths ?? 1} day={type?.askDay ?? 1} fe={fe} uid={uid} />
                <Offset label="Overdue from" monthsName="overdueAfterMonths" dayName="overdueDay" months={type?.overdueAfterMonths ?? 1} day={type?.overdueDay ?? 10} fe={fe} uid={uid} />
              </div>
            </fieldset>
          )}
          {scheduled && (
            <label className="flex items-center gap-2 text-[13.5px]">
              <input type="checkbox" name="reminders" defaultChecked={type?.reminders ?? true} className="h-4 w-4 accent-accent" /> Reminders
            </label>
          )}
        </>
      )}
      <div>
        <label className="block text-[13.5px] font-medium">Also known as <span className="font-normal text-ink-3">(optional, separate with commas)</span>
          <input name="aliases" defaultValue={type?.aliases.join(", ")} className={inputCls} {...err("aliases")} />
        </label>
        <FieldError id={`${uid}-aliases`} message={fe.aliases} />
      </div>
      <div>
        <label className="block text-[13.5px] font-medium">Used for <span className="font-normal text-ink-3">(optional — the filing it feeds)</span>
          <input name="usedFor" defaultValue={type?.usedFor ?? ""} maxLength={200} className={inputCls} {...err("usedFor")} />
        </label>
        <FieldError id={`${uid}-usedFor`} message={fe.usedFor} />
      </div>
      {type && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <input type="checkbox" name="active" defaultChecked={type.active} className="h-4 w-4 accent-accent" />
          Active <span className="text-ink-3">(inactive types aren&apos;t offered for new plans; existing clients keep them)</span>
        </label>
      )}
      {type && source === "client" && <p className="text-[13px] text-ink-3">Existing clients keep their own schedule.</p>}
      <FormFooter state={state} pending={pending} close={close} />
    </form>
  );
}
