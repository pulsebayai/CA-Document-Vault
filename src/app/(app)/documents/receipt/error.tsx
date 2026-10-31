"use client";

import { ErrorState } from "@/components/states";

/** Log receipt error state (13). */
export default function LogReceiptError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="The Log receipt form could not be loaded." retry={retry} />;
}
