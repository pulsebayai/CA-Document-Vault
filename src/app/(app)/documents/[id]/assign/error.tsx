"use client";

import { ErrorState } from "@/components/states";

export default function AssignDocumentError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="The document could not be loaded." retry={retry} />;
}
