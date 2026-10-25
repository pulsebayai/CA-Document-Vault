import type { Metadata } from "next";
import type { ReactNode } from "react";

// Feature 10 — the public upload page has no staff header, no navigation and is never indexed (AC-10).
export const metadata: Metadata = {
  title: "Upload documents",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function UploadLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-canvas">{children}</div>;
}
