"use client";

import { useActionState } from "react";
import { loginStep, type LoginState } from "@/lib/auth/actions";
import { Button } from "@/components/ui";

const input = "mt-1.5 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft";

export function LoginForm() {
  const [state, act, pending] = useActionState<LoginState, FormData>(loginStep, { step: "email" });

  if (state.step === "email") {
    return (
      <form action={act} className="mt-5 space-y-4" noValidate>
        <input type="hidden" name="intent" value="send" />
        <label className="block text-[13.5px] font-medium">
          Work email
          <input name="email" type="email" autoComplete="email" required autoFocus className={input} aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "login-error" : undefined} />
        </label>
        {state.error && <p id="login-error" role="alert" className="text-[13.5px] text-bad">{state.error}</p>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Sending…" : "Send code"}</Button>
      </form>
    );
  }

  return (
    <div className="mt-5 space-y-4">
      <p className="text-[13.5px] text-ink-2" role="status">{state.message}</p>
      <form action={act} className="space-y-4" noValidate>
        <input type="hidden" name="intent" value="verify" />
        <label className="block text-[13.5px] font-medium">
          6-digit code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus className={`${input} tracking-[0.4em]`} aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "login-error" : undefined} />
        </label>
        {state.error && <p id="login-error" role="alert" className="text-[13.5px] text-bad">{state.error}</p>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Checking…" : "Verify and sign in"}</Button>
      </form>
      <form action={act}>
        <input type="hidden" name="intent" value="send" />
        <input type="hidden" name="email" value={state.email} />
        <button type="submit" disabled={pending} className="text-[13.5px] text-accent underline-offset-2 hover:underline">
          Send a new code to {state.email}
        </button>
      </form>
    </div>
  );
}
