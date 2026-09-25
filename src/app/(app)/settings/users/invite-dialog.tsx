"use client";

import { useActionState, useRef } from "react";
import { inviteStaff, type ActionResult } from "@/lib/staff/actions";
import { ROLES, ROLE_LABEL } from "@/lib/auth/roles";
import { Button } from "@/components/ui";

const input = "mt-1.5 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft";

export function InviteDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, act, pending] = useActionState<ActionResult | null, FormData>(inviteStaff, null);

  return (
    <>
      <Button type="button" onClick={() => dialog.current?.showModal()}>+ Invite a person</Button>
      <dialog ref={dialog} aria-labelledby="invite-title" className="m-auto w-full max-w-md rounded-xl p-0 shadow-card backdrop:bg-ink/30">
        <form action={act} className="space-y-4 p-6">
          <h2 id="invite-title" className="text-lg font-semibold">Invite a person</h2>
          <p className="text-[13.5px] text-ink-2">They&apos;ll get an email and sign in with a 6-digit code.</p>
          <label className="block text-[13.5px] font-medium">Name<input name="fullName" required maxLength={120} className={input} /></label>
          <label className="block text-[13.5px] font-medium">Work email<input name="email" type="email" required className={input} /></label>
          <label className="block text-[13.5px] font-medium">Role
            <select name="role" defaultValue="staff" className={input}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          {state && <p role={state.ok ? "status" : "alert"} className={`text-[13.5px] ${state.ok ? "text-ok" : "text-bad"}`}>{state.ok ? state.message : state.error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => dialog.current?.close()}>Close</Button>
            <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send invite"}</Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
