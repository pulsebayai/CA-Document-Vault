"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

// A dialog opened by code (not by its own trigger button), for 08's bulk flows. Same base as the shared Modal:
// native <dialog> + showModal gives focus trapping, Esc and an inert background; the title labels it.
export function ActionDialog({ open, title, onClose, children, busy = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode;
  /** While busy, Esc doesn't close it (the caller offers Cancel instead). */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const onCancel = useCallback((e: React.SyntheticEvent) => { if (busy) e.preventDefault(); }, [busy]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onCancel={onCancel}
      className="m-auto w-full max-w-lg rounded-xl p-0 text-left shadow-card backdrop:bg-ink/30">
      <div className="p-6">
        <h2 id={titleId} className="mb-4 text-lg font-semibold">{title}</h2>
        {open && children}
      </div>
    </dialog>
  );
}
