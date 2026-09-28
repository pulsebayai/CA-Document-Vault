"use client";

import type { ReactNode } from "react";
import { Button, Card } from "@/components/ui";

// Spec 02 UX: every screen has loading (skeleton) and error (banner + retry) states.
// Loading = a live status region with visible grey blocks and a screen-reader label
// (aria-label on a plain div is not allowed by ARIA, so the text is sr-only instead).

export function LoadingState({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

export const Block = ({ className }: { className: string }) => <div className={`animate-pulse bg-panel ${className}`} />;

/** Header + card skeleton used by list, form and detail screens. */
export function PageSkeleton({ label, variant }: { label: string; variant: "list" | "form" | "detail" | "cards" }) {
  return (
    <LoadingState label={label}>
      {variant === "list" && (
        <>
          <Block className="mb-5 h-12 w-48 rounded-lg" />
          <Block className="mb-4 h-10 w-full max-w-[440px] rounded-[10px]" />
          <Block className="h-64 rounded-xl shadow-card" />
        </>
      )}
      {variant === "form" && (
        <div className="mx-auto max-w-[760px]">
          <Block className="mb-5 h-12 w-56 rounded-lg" />
          <Block className="h-[420px] rounded-xl shadow-card" />
        </div>
      )}
      {variant === "detail" && (
        <div className="mx-auto max-w-[1100px]">
          <Block className="mb-3 h-4 w-32 rounded" />
          <Block className="mb-5 h-12 w-72 rounded-lg" />
          <Block className="mb-4 h-9 w-full rounded" />
          <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
            <Block className="h-72 rounded-xl shadow-card" />
            <Block className="h-48 rounded-xl shadow-card" />
          </div>
        </div>
      )}
      {variant === "cards" && (
        <div className="space-y-5">
          {[0, 1, 2].map((i) => <Block key={i} className="h-40 rounded-xl shadow-card" />)}
        </div>
      )}
    </LoadingState>
  );
}

/** Error banner + retry. Never shows error details (they may contain data). */
export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Card className="px-6 py-8">
      <p role="alert" className="font-medium text-bad">{message}</p>
      <p className="mt-1 text-ink-2">Check your connection and try again.</p>
      <Button className="mt-4" variant="secondary" onClick={() => retry()}>Try again</Button>
    </Card>
  );
}
