"use client";

import { ErrorState } from "@/components/states";

/** Add client error state. */
export default function NewClientError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="The Add client form could not be loaded." retry={retry} />;
}
