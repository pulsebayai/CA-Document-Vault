"use client";

import { useId, useMemo, useRef, useState } from "react";
import { matchTypes, type TypeOption as MatchOption } from "@/lib/types/match";
import { FREQUENCY_LABEL, type Frequency } from "@/lib/validation/catalogue";

// Feature 12, spec AC-1 … AC-7 (Sankar's prototype; D4): the type-ahead Document type field. An ARIA 1.2 combobox
// (input + listbox, aria-activedescendant). Matching is pure and local (src/lib/types/match.ts), so typing never
// waits for the server. Tested in tests/unit/type-combobox.test.tsx.

export type ComboType = MatchOption;

type Row =
  | { kind: "type"; key: string; type: ComboType; right: string }
  | { kind: "propose"; key: string };

const control = "w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad disabled:bg-canvas";

export function TypeCombobox({ id, types, value, onChange, disabled, invalid, describedBy, canPropose, onPropose }: {
  id: string;
  types: ComboType[];
  /** The chosen type's ID ("" = none). */
  value: string;
  onChange: (typeId: string) => void;
  /** AC-7: locked for an expected or requested item. */
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** AC-5: Staff+ with a client chosen may propose a new type (03's step). */
  canPropose: boolean;
  onPropose: (text: string) => void;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const chosen = types.find((t) => t.id === value);
  const [text, setText] = useState<string | null>(null); // null = not editing: show the chosen type's name
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  const shown = text ?? chosen?.name ?? "";
  // While the field shows the last pick unedited, list as for an empty field (AC-1).
  const result = useMemo(() => matchTypes(types, text ?? ""), [types, text]);

  const groups: { heading: string; kind: "group" | "other" | "close"; rows: Row[] }[] = result.sections.map((s) => ({
    heading: s.heading, kind: s.kind,
    rows: s.rows.map(({ type }) => ({
      kind: "type" as const, key: type.id, type,
      right: s.kind === "group" ? (FREQUENCY_LABEL[type.frequency as Frequency] ?? type.frequency) : type.groupName,
    })),
  }));
  if (result.noMatch && result.close.length) {
    groups.push({ heading: "Close types", kind: "close", rows: result.close.map((type) => ({ kind: "type" as const, key: type.id, type, right: type.groupName })) });
  }
  const proposeRow = result.noMatch && canPropose && (text ?? "").trim().length >= 2;
  const rows: Row[] = [...groups.flatMap((g) => g.rows), ...(proposeRow ? [{ kind: "propose" as const, key: "__propose__" }] : [])];
  const optId = (r: Row) => `${uid}-opt-${r.key}`;
  const activeRow = open && active >= 0 && active < rows.length ? rows[active] : null;

  function close(restore: boolean) {
    setOpen(false);
    setActive(-1);
    if (restore) setText(null);
  }
  function pick(r: Row) {
    if (r.kind === "propose") {
      onPropose((text ?? "").trim());
      close(true);
      return;
    }
    onChange(r.type.id);
    close(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(e.key === "ArrowDown" ? 0 : rows.length - 1); return; }
      if (rows.length === 0) return;
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % rows.length : (i <= 0 ? rows.length - 1 : i - 1)));
    } else if (e.key === "Enter") {
      if (!open) return; // a closed field lets Enter behave as usual
      e.preventDefault(); // never submit the form from the list
      if (activeRow) pick(activeRow);
      else if (rows.length === 1) pick(rows[0]);
    } else if (e.key === "Escape") {
      if (open || text !== null) { e.preventDefault(); close(true); }
    } else if (e.key === "Tab") {
      close(true);
    }
  }

  const popover = open && !disabled;
  let index = -1;
  return (
    <div className="relative">
      <input
        ref={input} id={id} type="text" role="combobox" autoComplete="off" spellCheck={false}
        aria-autocomplete="list" aria-expanded={popover} aria-controls={listId}
        aria-activedescendant={activeRow ? optId(activeRow) : undefined}
        aria-invalid={invalid || undefined} aria-describedby={describedBy}
        placeholder="Type to search, e.g. 3B or bank" disabled={disabled}
        value={shown}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => close(true)}
        onKeyDown={onKeyDown}
        className={control}
      />
      {/* The listbox stays in the DOM (aria-controls must point at it); it is hidden while closed. */}
      <div hidden={!popover}
        className="absolute z-20 mt-1 max-h-[22rem] w-full overflow-y-auto rounded-[10px] border border-line-2 bg-panel py-1 shadow-lg">
        <div role="listbox" id={listId} aria-label="Matching types">
          {groups.map((g, gi) => (
            <div key={`${g.kind}-${g.heading}`} role="group" aria-labelledby={`${uid}-h${gi}`}>
              <div id={`${uid}-h${gi}`} role="presentation"
                className="px-3 pb-1 pt-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-3">{g.heading}</div>
              {g.rows.map((r) => {
                index++;
                const i = index;
                return r.kind === "type" ? (
                  <div key={r.key} id={optId(r)} role="option" aria-selected={i === active}
                    // mousedown, not click: the input's blur would close the list first
                    onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                    onMouseMove={() => setActive(i)}
                    className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-[14px] ${i === active ? "bg-accent-soft" : ""}`}>
                    <span className="min-w-0 break-words">
                      {r.type.name}
                      {r.type.proposed && <span className="ml-1.5 text-[12px] text-warn">Proposed</span>}
                    </span>
                    <span className="shrink-0 text-[12.5px] text-ink-3">{r.right}</span>
                  </div>
                ) : null;
              })}
            </div>
          ))}
          {proposeRow && (() => {
            index++;
            const i = index;
            const r = rows[rows.length - 1];
            return (
              <div id={optId(r)} role="option" aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                onMouseMove={() => setActive(i)}
                className={`mt-1 cursor-pointer border-t border-line px-3 py-2 text-[14px] text-accent ${i === active ? "bg-accent-soft" : ""}`}>
                + Propose a new type… <span className="text-[12.5px] text-ink-3">needs approval</span>
              </div>
            );
          })()}
        </div>
        {result.more > 0 && <p className="px-3 pb-1 pt-1.5 text-[12.5px] text-ink-3">{result.more} more — keep typing to narrow</p>}
        {result.searchAll && <p className="px-3 py-2 text-[13px] text-ink-3">Type to search all types</p>}
        {result.noMatch && !proposeRow && <p className="px-3 py-2 text-[13px] text-ink-3">No matching type</p>}
      </div>
    </div>
  );
}
