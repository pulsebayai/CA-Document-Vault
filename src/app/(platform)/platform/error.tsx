"use client";

import { ErrorState } from "@/components/states";

/** Error state (banner + retry). No error details are shown to the browser. */
export default function PlatformError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="This page could not be loaded." retry={retry} />;
}
