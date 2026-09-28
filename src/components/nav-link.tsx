"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children, label }: { href: string; children: ReactNode; label?: string }) {
  const path = usePathname();
  const section = `/${href.split("/")[1]}`; // e.g. "/settings"
  const active = path === section || path.startsWith(`${section}/`);
  return (
    <Link href={href} aria-current={active ? "page" : undefined} aria-label={label}
      className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 ${active ? "bg-ink font-medium text-white" : "text-ink-2 hover:bg-canvas hover:text-ink"}`}>
      {children}
    </Link>
  );
}

/** Header "+ Add document" (mockup): comes back to the page it was clicked on (spec 03 AC-4). */
export function AddDocumentLink() {
  const path = usePathname();
  const from = /^\/clients(\/[0-9a-f-]{36})?$|^\/inbox$/.test(path) ? `?from=${path}` : "";
  return (
    <Link href={`/documents/new${from}`} aria-label="Add document" className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-[9px] bg-accent px-3 py-2 font-medium text-white hover:bg-[#264d8f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-3.5">
      <span aria-hidden>+</span><span aria-hidden className="hidden sm:inline">Add document</span>
    </Link>
  );
}
