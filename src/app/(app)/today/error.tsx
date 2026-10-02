"use client";

import { ErrorState } from "@/components/states";

export default function TodayError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="Today could not be loaded." retry={retry} />;
}
