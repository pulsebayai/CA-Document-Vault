"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { PlatformResult } from "@/lib/platform/actions";
import { Button } from "@/components/ui";

// 19: client pieces of the Platform area — the access countdown, the reason forms (suspend, open access) and
// one-click actions (reactivate, close access, resend invite). Results are announced in a live region.

const input = "mt-1.5 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad";

const NOTICE = "platform:notice";
/** Tell the firm layout's status region (it stays mounted while the page re-renders into its new state). */
const announce = (message: string) => window.dispatchEvent(new CustomEvent(NOTICE, { detail: message }));

/**
 * The firm page's status region. A suspend or an opened window re-renders the card that held the form, so the form's
 * own message would vanish with it; this region lives in the layout, so the result is still seen and announced.
 */
export function Notices() {
  const pathname = usePathname();
  const [notice, setNotice] = useState({ message: "", path: "" });
  useEffect(() => {
    const on = (e: Event) => setNotice({ message: String((e as CustomEvent).detail ?? ""), path: window.location.pathname });
    window.addEventListener(NOTICE, on);
    return () => window.removeEventListener(NOTICE, on);
  }, []);
  const message = notice.path === pathname ? notice.message : ""; // a result belongs to the page it happened on
  return (
    <p role="status" className={message ? "mb-4 rounded-lg bg-ok-soft px-3 py-2 text-[13.5px] text-ok" : "sr-only"}>{message}</p>
  );
}

const left = (until: number) => Math.max(0, Math.floor((until - Date.now()) / 1000));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** "Ends in 59:12"; when it reaches zero the page refreshes, so the views show "not open" (the database decides). */
export function Countdown({ expiresAt }: { expiresAt: string }) {
  const until = new Date(expiresAt).getTime();
  const router = useRouter();
  const [secs, setSecs] = useState<number | null>(null); // null until mounted: the server's clock isn't the browser's
  useEffect(() => {
    const tick = () => {
      const s = left(until);
      setSecs(s);
      if (s === 0) { clearInterval(timer); router.refresh(); }
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [until, router]);
  // the visible clock is aria-hidden (it would announce every second); the minutes are given once for screen readers
  return (
    <span>
      <span aria-hidden="true" className="font-mono tabular-nums">{secs === null ? "—" : secs === 0 ? "ended" : mmss(secs)}</span>
      <span className="sr-only">{secs === null ? "" : `about ${Math.ceil(secs / 60)} minutes left`}</span>
    </span>
  );
}

/** A form with a required reason (10–500 characters): suspend a firm, open read access. */
export function ReasonForm({ action, label, hint, submit, pendingLabel, variant = "primary", id }: {
  action: (prev: PlatformResult | null, form: FormData) => Promise<PlatformResult>;
  label: string; hint: string; submit: string; pendingLabel: string; variant?: "primary" | "danger"; id: string;
}) {
  // announce as soon as the result arrives: on success the page re-renders without this form, so an effect here
  // would never run
  const [state, act, pending] = useActionState<PlatformResult | null, FormData>(async (prev, form) => {
    const r = await action(prev, form);
    if (r.ok) announce(r.message);
    return r;
  }, null);
  const err = state && !state.ok ? state.fieldErrors?.reason : undefined;
  return (
    <form action={act} className="max-w-xl space-y-3" noValidate>
      <label className="block text-[13.5px] font-medium" htmlFor={`${id}-reason`}>{label}</label>
      <p id={`${id}-hint`} className="-mt-2 text-[13px] text-ink-3">{hint}</p>
      <textarea id={`${id}-reason`} name="reason" required minLength={10} maxLength={500} rows={3} className={input}
        aria-invalid={err ? true : undefined} aria-describedby={`${id}-hint${err ? ` ${id}-error` : ""}`} />
      {err && <p id={`${id}-error`} className="text-[13px] text-bad">{err}</p>}
      {state && !state.ok && !err && <p role="alert" className="text-[13.5px] text-bad">{state.error}</p>}
      <Button type="submit" variant={variant} disabled={pending}>{pending ? pendingLabel : submit}</Button>
    </form>
  );
}

/** One click, then the result in a live region (reactivate, close access, resend invite). */
export function ActionButton({ run, children, pendingLabel, variant = "secondary" }: {
  run: () => Promise<PlatformResult>; children: string; pendingLabel: string; variant?: "primary" | "secondary" | "danger";
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<PlatformResult | null>(null);
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" size="sm" variant={variant} disabled={pending}
        onClick={() => start(async () => { const r = await run(); setState(r.ok ? null : r); if (r.ok) { announce(r.message); router.refresh(); } })}>
        {pending ? pendingLabel : children}
      </Button>
      <p role="alert" className="text-[13.5px] text-bad">{state && !state.ok ? state.error : ""}</p>
    </div>
  );
}
