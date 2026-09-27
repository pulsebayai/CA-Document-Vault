"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui";

// Shared form dialog pieces (Settings › Catalogue, Client › Settings). Native <dialog> + showModal gives
// focus trapping, Esc to close and an inert background; the title labels the dialog.

export const inputCls = "mt-1 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 text-[14px] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad";
export const numCls = "mt-1 w-20 rounded-[9px] border border-line-2 bg-panel px-2 py-1.5 text-[14px] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad";

export function Modal({ trigger, title, triggerVariant, children }: {
  trigger: string; title: string; triggerVariant: "link" | "button"; children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <>
      {triggerVariant === "link" ? (
        <button type="button" className="text-[13.5px] font-medium text-accent hover:underline" onClick={() => setOpen(true)}>{trigger}</button>
      ) : (
        <Button size="sm" variant="secondary" aria-label={title} onClick={() => setOpen(true)}>{trigger}</Button>
      )}
      <dialog ref={ref} aria-labelledby={titleId} onClose={close} className="m-auto w-full max-w-lg rounded-xl p-0 text-left shadow-card backdrop:bg-ink/30">
        <div className="p-6">
          <h2 id={titleId} className="mb-4 text-lg font-semibold">{title}</h2>
          {/* Mounted only while open, so fields always start from the saved values. */}
          {open && children(close)}
        </div>
      </dialog>
    </>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} className="mt-1 text-[13px] text-bad">{message}</p> : null;
}


export function Offset({ label, monthsName, dayName, months, day, fe, uid }: {
  label: string; monthsName: string; dayName: string; months: number; day: number; fe: Record<string, string>; uid: string;
}) {
  const a = (f: string) => ({ "aria-invalid": !!fe[f], "aria-describedby": fe[f] ? `${uid}-${f}` : undefined });
  return (
    <div>
      <p className="text-[13.5px] font-medium">{label}</p>
      <div className="flex gap-3">
        <label className="text-[13px] text-ink-2"><span className="sr-only">{label}: </span>Months after
          <input name={monthsName} type="number" min={0} max={12} defaultValue={months} className={`block ${numCls}`} {...a(monthsName)} />
        </label>
        <label className="text-[13px] text-ink-2"><span className="sr-only">{label}: </span>Day
          <input name={dayName} type="number" min={1} max={31} defaultValue={day} className={`block ${numCls}`} {...a(dayName)} />
        </label>
      </div>
      <FieldError id={`${uid}-${monthsName}`} message={fe[monthsName]} />
      <FieldError id={`${uid}-${dayName}`} message={fe[dayName]} />
    </div>
  );
}
