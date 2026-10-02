"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { openNotifications } from "@/lib/notifications/actions";
import type { NotificationList } from "@/lib/notifications/queries";

// Feature 05 AC-13 / S4: the header bell. A disclosure button ("Notifications, N unread") opening a panel of the newest
// 20; opening it marks them all read. Esc and a click outside close it; focus returns to the button.

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

export function NotificationBell({ unread: initialUnread }: { unread: number }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [list, setList] = useState<NotificationList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const load = () => start(async () => {
    setError(null);
    const r = await openNotifications();
    if (r.ok) { setList(r.list); setUnread(0); } else setError(r.error);
  });

  const close = () => { setOpen(false); button.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onClick = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onClick); };
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button ref={button} type="button" aria-expanded={open} aria-controls={panelId}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => { const next = !open; setOpen(next); if (next) load(); }}
        className="relative grid h-8 w-8 place-items-center rounded-full text-ink-2 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-accent">
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-grid min-w-4 place-items-center rounded-full bg-bad px-1 text-[11px] font-semibold leading-4 text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} role="region" aria-label="Notifications"
          className="fixed inset-x-3 top-14 z-20 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-panel shadow-card sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-96">
          <h2 className="border-b border-line px-4 py-2.5 text-[13.5px] font-semibold">Notifications</h2>
          {error ? (
            <div role="alert" className="px-4 py-3 text-[13.5px] text-bad">
              {error} <button type="button" className="ml-1 font-medium text-accent hover:underline" onClick={load}>Try again</button>
            </div>
          ) : !list || pending ? (
            <p role="status" className="px-4 py-3 text-[13.5px] text-ink-2">Loading…</p>
          ) : list.items.length === 0 ? (
            <p className="px-4 py-3 text-[13.5px] text-ink-3">No notifications</p>
          ) : (
            <ul className="divide-y divide-line">
              {list.items.map((n) => (
                <li key={n.id} className={`px-4 py-2.5 text-[13.5px] ${n.unread ? "bg-accent-soft/40" : ""}`}>
                  {n.unread && <span className="sr-only">New: </span>}
                  <span>{n.text}</span>
                  <span className="block text-[12.5px] text-ink-3">{when.format(new Date(n.createdAt))}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
