"use client";

import { useEffect, useId, useState } from "react";
import { inputCls } from "@/components/dialog";
import { Button } from "@/components/ui";
import type { AdHocItem } from "@/lib/reminders/message";
import { linkOptions } from "@/lib/upload-links/actions";
import { NOTE_MAX, NOTE_PII_MESSAGE, notePii } from "@/lib/upload-links/note";
import type { LinkOptions, LinkTypeOption } from "@/lib/upload-links/queries";

// Feature 10 step 6 — the "Include upload link" part of the Remind dialog (spec AC-1, AC-3, AC-4).
// Ad-hoc rows: type (required), period (when the type has one), registration (when the type is per GSTIN/TAN),
// needed-by date, note (≤ 200, checked for personal data as you type; the server checks again).

export type AdHocRow = { key: string; docTypeId: string; periodId: string; registrationId: string; neededBy: string; note: string };
export const newRow = (): AdHocRow => ({ key: Math.random().toString(36).slice(2), docTypeId: "", periodId: "", registrationId: "", neededBy: "", note: "" });

export function useLinkOptions(clientId: string, on: boolean) {
  const [state, setState] = useState<{ data?: LinkOptions; error?: string }>({});
  useEffect(() => {
    if (!on || state.data) return;
    let live = true;
    linkOptions(clientId).then((r) => { if (live) setState(r.ok ? { data: r.data } : { error: r.error }); },
      () => live && setState({ error: "Could not load document types. Please try again." }));
    return () => { live = false; };
  }, [clientId, on, state.data]);
  return state;
}

/** Rows ready to send (complete and valid), or a message saying what to fix. */
export function adHocProblems(rows: AdHocRow[], today: string): string | null {
  for (const r of rows) {
    if (!r.docTypeId) return "Choose a document type for each requested document.";
    if (r.neededBy && r.neededBy < today) return "A needed-by date can't be in the past.";
    if (r.note.trim().length > NOTE_MAX) return `Keep each note to ${NOTE_MAX} characters.`;
    if (notePii(r.note)) return NOTE_PII_MESSAGE;
  }
  return null;
}

/** The message lines the preview shows for the ad-hoc rows (labels from the options). */
export function adHocPreview(rows: AdHocRow[], options: LinkOptions | undefined): AdHocItem[] {
  if (!options) return [];
  return rows.filter((r) => r.docTypeId).map((r) => {
    const t = options.types.find((x) => x.id === r.docTypeId);
    const p = options.periods.find((x) => x.id === r.periodId);
    return { group: t?.group ?? "", type: t?.name ?? "", period: p?.label ?? null, neededBy: r.neededBy || null, note: r.note.trim() || null };
  });
}

export function AdHocEditor({ rows, setRows, options, today, disabled }: {
  rows: AdHocRow[]; setRows: (r: AdHocRow[]) => void; options: LinkOptions; today: string; disabled: boolean;
}) {
  const update = (key: string, patch: Partial<AdHocRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const groups = [...new Set(options.types.map((t) => t.group))];
  return (
    <div>
      <h3 className="mb-1 text-[13px] font-medium text-ink-2">Other documents to request</h3>
      {rows.length === 0 && <p className="text-[13px] text-ink-3">For &ldquo;as needed&rdquo; or one-off documents. Each needs a type.</p>}
      <ul className="space-y-3">
        {rows.map((r, n) => <AdHocRowEditor key={r.key} n={n + 1} row={r} groups={groups} options={options} today={today} disabled={disabled}
          onChange={(patch) => update(r.key, patch)} onRemove={() => setRows(rows.filter((x) => x.key !== r.key))} />)}
      </ul>
      {rows.length < 20 && (
        <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={disabled} onClick={() => setRows([...rows, newRow()])}>
          + Request another document
        </Button>
      )}
    </div>
  );
}

function AdHocRowEditor({ n, row, groups, options, today, disabled, onChange, onRemove }: {
  n: number; row: AdHocRow; groups: string[]; options: LinkOptions; today: string; disabled: boolean;
  onChange: (p: Partial<AdHocRow>) => void; onRemove: () => void;
}) {
  const id = useId();
  const type: LinkTypeOption | undefined = options.types.find((t) => t.id === row.docTypeId);
  const periods = type && type.periodKind !== "none" ? options.periods.filter((p) => p.kind === type.periodKind) : [];
  const regs = type?.registrationKind ? options.registrations.filter((r) => r.kind === type.registrationKind) : [];
  const pii = notePii(row.note);
  return (
    <li className="rounded-lg border border-line p-3">
      <fieldset disabled={disabled}>
        <legend className="sr-only">Requested document {n}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-type`} className="text-[13px] font-medium text-ink-2">Document type</label>
            <select id={`${id}-type`} className={inputCls} value={row.docTypeId} required
              onChange={(e) => onChange({ docTypeId: e.target.value, periodId: "", registrationId: "" })}>
              <option value="">Choose a type…</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {options.types.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.name}{t.proposed ? " (proposed)" : ""}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          {periods.length > 0 && (
            <div>
              <label htmlFor={`${id}-period`} className="text-[13px] font-medium text-ink-2">Period (optional)</label>
              <select id={`${id}-period`} className={inputCls} value={row.periodId} onChange={(e) => onChange({ periodId: e.target.value })}>
                <option value="">Any</option>
                {periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
          )}
          {regs.length > 0 && (
            <div>
              <label htmlFor={`${id}-reg`} className="text-[13px] font-medium text-ink-2">Registration (optional)</label>
              <select id={`${id}-reg`} className={inputCls} value={row.registrationId} onChange={(e) => onChange({ registrationId: e.target.value })}>
                <option value="">Not specific</option>
                {regs.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor={`${id}-need`} className="text-[13px] font-medium text-ink-2">Needed by (optional)</label>
            <input id={`${id}-need`} type="date" className={inputCls} min={today} value={row.neededBy} onChange={(e) => onChange({ neededBy: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-note`} className="text-[13px] font-medium text-ink-2">Note for the client (optional)</label>
            <input id={`${id}-note`} className={inputCls} maxLength={NOTE_MAX} value={row.note} aria-describedby={`${id}-hint`}
              aria-invalid={pii ? true : undefined} onChange={(e) => onChange({ note: e.target.value })} />
            <p id={`${id}-hint`} className={`mt-0.5 text-[12px] ${pii ? "text-bad" : "text-ink-3"}`}>
              {pii ? NOTE_PII_MESSAGE : "Shown to the client. No PAN, GSTIN or account numbers."}
            </p>
          </div>
        </div>
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" variant="danger" onClick={onRemove}>Remove</Button>
        </div>
      </fieldset>
    </li>
  );
}
