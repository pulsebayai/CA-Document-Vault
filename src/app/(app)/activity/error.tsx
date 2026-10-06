"use client";

import { ErrorState } from "@/components/states";

export default function ActivityError({ retry }: { error: Error; retry: () => void }) {
  return <div className="mx-auto max-w-[815px]"><ErrorState message="Activity could not be loaded." retry={retry} /></div>;
}
