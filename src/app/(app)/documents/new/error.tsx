"use client";

import { ErrorState } from "@/components/states";

/** Add document error state. */
export default function NewDocumentError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="The Add document form could not be loaded." retry={retry} />;
}
