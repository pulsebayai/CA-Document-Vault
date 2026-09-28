"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const section = `/${href.split("/")[1]}`; // e.g. "/settings"
  const active = path === section || path.startsWith(`${section}/`);
  return (
    <Link href={href} aria-current={active ? "page" : undefined}
      className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 ${active ? "bg-ink font-medium text-white" : "text-ink-2 hover:bg-canvas hover:text-ink"}`}>
      {children}
    </Link>
  );
}
