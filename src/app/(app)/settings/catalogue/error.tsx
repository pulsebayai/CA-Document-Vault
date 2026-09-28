"use client";

import { ErrorState } from "@/components/states";

/** Error state (spec: banner + retry). No error details are shown to the browser. */
export default function CatalogueError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState message="The catalogue could not be loaded." retry={retry} />;
}
