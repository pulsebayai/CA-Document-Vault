"use client";

import { ErrorState } from "@/components/states";

/** Error state (banner + retry). No error details are shown to the browser. */
export default function OfficeError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="The office details could not be loaded." retry={retry} />;
}
