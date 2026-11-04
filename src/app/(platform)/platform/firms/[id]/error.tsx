"use client";

import { ErrorState } from "@/components/states";

export default function FirmError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="This firm's page could not be loaded." retry={retry} />;
}
