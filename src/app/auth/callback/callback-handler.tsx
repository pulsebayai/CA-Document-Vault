"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { completeInviteSignIn, completeLinkSignIn } from "@/lib/auth/actions";
import { createClient } from "@/lib/supabase/client";

const FAILED = "This sign-in link has expired, was already used, or was opened in a different browser. Request a new link on this device.";

export function CallbackHandler() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // links are single-use: never run twice
    started.current = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    // Remove tokens from the address bar and history immediately.
    window.history.replaceState(null, "", window.location.pathname);

    (async () => {
      const code = params.get("code");
      if (code) {
        const r = await completeLinkSignIn(code);
        setError(r?.error ?? FAILED);
        return;
      }
      const access_token = hash.get("access_token");
      const refresh_token = hash.get("refresh_token");
      if (access_token && refresh_token) {
        const { error: e } = await createClient().auth.setSession({ access_token, refresh_token });
        if (e) return setError(FAILED);
        await completeInviteSignIn();
        return;
      }
      setError(FAILED);
    })().catch(() => undefined); // redirects are thrown by server actions and handled by Next
  }, [params]);

  if (!error) return <p role="status">Signing you in…</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Couldn&apos;t sign you in</h1>
      <p role="alert" className="text-[13.5px] text-bad">{error}</p>
      <Link href="/login" className="inline-block text-accent underline-offset-2 hover:underline">Back to sign in</Link>
    </div>
  );
}
