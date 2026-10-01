"use client";

import { ErrorState } from "@/components/states";

export default function DocumentsError({ retry }: { error: Error; retry: () => void }) {
  return <div className="mx-auto max-w-[1100px]"><ErrorState message="Documents could not be loaded." retry={retry} /></div>;
}
