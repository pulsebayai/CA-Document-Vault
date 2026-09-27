"use client";

import { ErrorState } from "@/components/states";

/** Client page / Edit error state. No error details reach the browser. */
export default function ClientError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="This client could not be loaded." retry={retry} />;
}
