"use client";

import { ErrorState } from "@/components/states";

export default function InboxError({ retry }: { error: Error; retry: () => void }) {
  return <div className="mx-auto max-w-[815px]"><ErrorState message="The Inbox could not be loaded." retry={retry} /></div>;
}
