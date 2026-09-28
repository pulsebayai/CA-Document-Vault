"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Settings sub-nav (mockups 05/06). Items are passed in already filtered by role. */
export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="flex flex-row gap-1 md:flex-col">
      {items.map((i) => {
        const active = path === i.href || path.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={`rounded-lg px-3 py-1.5 text-[14px] ${active ? "bg-panel font-medium text-ink shadow-card" : "text-ink-2 hover:bg-panel hover:text-ink"}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
