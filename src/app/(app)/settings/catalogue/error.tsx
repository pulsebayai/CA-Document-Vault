"use client";

import { Button, Card } from "@/components/ui";

/** Error state (spec: banner + retry). No error details are shown to the browser. */
export default function CatalogueError({ retry }: { error: Error; retry: () => void }) {
  return (
    <Card className="px-6 py-8">
      <p role="alert" className="font-medium text-bad">The catalogue could not be loaded.</p>
      <p className="mt-1 text-ink-2">Check your connection and try again.</p>
      <Button className="mt-4" variant="secondary" onClick={() => retry()}>Try again</Button>
    </Card>
  );
}
