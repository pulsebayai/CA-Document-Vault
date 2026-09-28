"use client";

import { ErrorState } from "@/components/states";

/** Error state (spec: banner + retry). No error details reach the browser. */
export default function ClientsError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="Clients could not be loaded." retry={retry} />;
}
