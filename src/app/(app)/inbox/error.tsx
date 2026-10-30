"use client";

import { ErrorState } from "@/components/states";

export default function InboxError({ retry }: { error: Error; retry: () => void }) {
  return <div className="mx-auto max-w-[815px]"><ErrorState message="Untagged documents could not be loaded." retry={retry} /></div>;
}
