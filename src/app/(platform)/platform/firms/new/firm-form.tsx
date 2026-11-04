"use client";

import { useActionState } from "react";
import type { PlatformResult } from "@/lib/platform/actions";
import { Button } from "@/components/ui";

const input = "mt-1.5 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad";

type Props = { action: (prev: PlatformResult | null, form: FormData) => Promise<PlatformResult>; test: boolean; adminOnly?: boolean };

/** The firm and its first Admin (adminOnly: just the Admin, for a firm whose first invite failed). */
export function FirmForm({ action, test, adminOnly = false }: Props) {
  const [state, act, pending] = useActionState<PlatformResult | null, FormData>(action, null);
  const errors = state && !state.ok ? state.fieldErrors ?? {} : {};
  const field = (name: string, label: string, opts: { optional?: boolean; type?: string; hint?: string } = {}) => (
    <div>
      <label className="block text-[13.5px] font-medium" htmlFor={`firm-${name}`}>
        {label}{opts.optional && <span className="font-normal text-ink-3"> (optional)</span>}
      </label>
      {opts.hint && <p id={`firm-${name}-hint`} className="mt-0.5 text-[13px] text-ink-3">{opts.hint}</p>}
      <input id={`firm-${name}`} name={name} type={opts.type ?? "text"} required={!opts.optional} maxLength={120} className={input}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={[opts.hint && `firm-${name}-hint`, errors[name] && `firm-${name}-error`].filter(Boolean).join(" ") || undefined} />
      {errors[name] && <p id={`firm-${name}-error`} className="mt-1 text-[13px] text-bad">{errors[name]}</p>}
    </div>
  );
  return (
    <form action={act} className="max-w-md space-y-4" noValidate>
      {!adminOnly && (
        <fieldset className="space-y-4">
          <legend className="mb-1 font-semibold">Firm</legend>
          {field("name", "Firm name", { hint: "Shown on the firm's header and as the sender of its client emails." })}
          {field("branch", "Branch", { optional: true })}
        </fieldset>
      )}
      <fieldset className="space-y-4">
        <legend className="mb-1 font-semibold">First Admin</legend>
        {field("adminName", "Name")}
        {field("adminEmail", "Work email", { type: "email", hint: test ? "Test super admin: a .test address (no email is sent)." : "They get an invite email and sign in with a code." })}
      </fieldset>
      {state && <p role={state.ok ? "status" : "alert"} className={`text-[13.5px] ${state.ok ? "text-ok" : "text-bad"}`}>{state.ok ? state.message : state.error}</p>}
      <Button type="submit" disabled={pending}>{pending ? (adminOnly ? "Sending…" : "Creating…") : adminOnly ? "Send invite" : "Create firm and send invite"}</Button>
    </form>
  );
}
