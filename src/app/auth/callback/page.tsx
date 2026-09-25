import { Suspense } from "react";
import { Card } from "@/components/ui";
import { CallbackHandler } from "./callback-handler";

export const dynamic = "force-dynamic";

/** Landing page for sign-in and invite links from Supabase emails. */
export default function AuthCallbackPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-[380px] p-6">
        <Suspense fallback={<p role="status">Signing you in…</p>}>
          <CallbackHandler />
        </Suspense>
      </Card>
    </main>
  );
}
