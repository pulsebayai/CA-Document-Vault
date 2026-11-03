"use client";

import { useActionState } from "react";
import type { OfficeResult } from "@/lib/office/actions";
import { Button } from "@/components/ui";

const input = "mt-1.5 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad";

type Props = {
  name: string;
  branch: string | null;
  action: (prev: OfficeResult | null, form: FormData) => Promise<OfficeResult>;
};

/** Feature 17 (spec AC-9). Firm name and branch; Admin only (the page 404s for others). */
export function OfficeForm({ name, branch, action }: Props) {
  const [state, act, pending] = useActionState<OfficeResult | null, FormData>(action, null);
  const fieldErrors = state && !state.ok ? state.fieldErrors : {};
  return (
    <form action={act} className="max-w-md space-y-4" noValidate>
      <label className="block text-[13.5px] font-medium">Firm name
        <input name="name" defaultValue={name} required maxLength={120} className={input}
          aria-invalid={fieldErrors.name ? true : undefined} aria-describedby={fieldErrors.name ? "office-name-error" : undefined} />
      </label>
      {fieldErrors.name && <p id="office-name-error" className="text-[13px] text-bad">{fieldErrors.name}</p>}
      <label className="block text-[13.5px] font-medium">Branch <span className="font-normal text-ink-3">(optional)</span>
        <input name="branch" defaultValue={branch ?? ""} maxLength={120} className={input}
          aria-invalid={fieldErrors.branch ? true : undefined} aria-describedby={fieldErrors.branch ? "office-branch-error" : undefined} />
      </label>
      {fieldErrors.branch && <p id="office-branch-error" className="text-[13px] text-bad">{fieldErrors.branch}</p>}
      {state && <p role={state.ok ? "status" : "alert"} className={`text-[13.5px] ${state.ok ? "text-ok" : "text-bad"}`}>{state.ok ? state.message : state.error}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
    </form>
  );
}
