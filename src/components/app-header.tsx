import Link from "next/link";
import { signOut } from "@/lib/auth/actions";
import { initials, ROLE_LABEL } from "@/lib/auth/roles";
import type { CurrentStaff } from "@/lib/auth/staff";
import { BrandMark } from "./ui";
import { AddDocumentLink, NavLink } from "./nav-link";

/** Mockup header (references/mockup/01-today.jpg). Only shipped screens appear in the nav. */
export function AppHeader({ me, inboxCount }: { me: CurrentStaff; inboxCount: number }) {
  // Settings is for everyone from 02: the catalogue is readable by all staff (AC-6); Users stays Admin only.
  const nav = [
    { href: "/inbox", label: "Inbox", count: inboxCount },
    { href: "/clients", label: "Clients" },
    { href: "/settings/catalogue", label: "Settings" },
  ];

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-line bg-white/[.92] px-4 backdrop-blur sm:gap-6 sm:px-6">
      <Link href="/clients" aria-label={me.officeName} className="flex shrink-0 items-center gap-2.5">
        <BrandMark />
        <span aria-hidden className="hidden leading-tight md:block">
          <span className="block font-semibold">{me.officeName}</span>
          {me.officeBranch && <span className="block text-xs text-ink-3">{me.officeBranch}</span>}
        </span>
      </Link>
      <nav aria-label="Main" className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {nav.map((n) => (
          // AC-7: count badge (Staff+: all Inbox items; Limited: their own — RLS). Named "Inbox, 3 waiting".
          <NavLink key={n.href} href={n.href} label={"count" in n && n.count ? `${n.label}, ${n.count} waiting` : undefined}>
            {n.label}
            {"count" in n && n.count ? <span aria-hidden className="ml-1.5 inline-grid min-w-5 place-items-center rounded-full bg-bad px-1.5 text-xs font-semibold text-white">{n.count}</span> : null}
          </NavLink>
        ))}
      </nav>
      {/* Mockup header "+ Add document"; on phones just "+" (same accessible name) so the header fits 390 px. */}
      <AddDocumentLink />
      <details className="relative shrink-0">
        <summary aria-label={`Account menu for ${me.fullName}`} className="grid h-8 w-8 cursor-pointer list-none place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent [&::-webkit-details-marker]:hidden">
          {initials(me.fullName)}
        </summary>
        <div className="absolute right-0 mt-2 w-60 rounded-xl border border-line bg-panel p-3 shadow-card">
          <p className="font-medium">{me.fullName}</p>
          <p className="truncate text-[13px] text-ink-3">{me.email}</p>
          <p className="mt-1 text-[13px] text-ink-2">{ROLE_LABEL[me.role]}</p>
          <form action={signOut} className="mt-3 border-t border-line pt-3">
            <button type="submit" className="w-full rounded-lg px-2 py-1.5 text-left text-[13.5px] hover:bg-canvas">Sign out</button>
          </form>
        </div>
      </details>
    </header>
  );
}
