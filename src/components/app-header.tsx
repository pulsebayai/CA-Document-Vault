import Link from "next/link";
import { signOut } from "@/lib/auth/actions";
import { initials, ROLE_LABEL } from "@/lib/auth/roles";
import type { CurrentStaff } from "@/lib/auth/staff";
import { BrandMark } from "./ui";
import { NavLink } from "./nav-link";

/** Mockup header (references/mockup/01-today.jpg). Only shipped screens appear in the nav. */
export function AppHeader({ me }: { me: CurrentStaff }) {
  // Settings is for everyone from 02: the catalogue is readable by all staff (AC-6); Users stays Admin only.
  const nav = [{ href: "/clients", label: "Clients" }, { href: "/settings/catalogue", label: "Settings" }];

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-6 border-b border-line bg-white/[.92] px-6 backdrop-blur">
      <Link href="/clients" className="flex items-center gap-2.5">
        <BrandMark />
        <span className="leading-tight">
          <span className="block font-semibold">{me.officeName}</span>
          {me.officeBranch && <span className="block text-xs text-ink-3">{me.officeBranch}</span>}
        </span>
      </Link>
      <nav aria-label="Main" className="flex items-center gap-1">
        {nav.map((n) => <NavLink key={n.href} href={n.href}>{n.label}</NavLink>)}
      </nav>
      {/* Mockup header "+ Add document"; on phones just "+" (same accessible name) so the header fits 390 px. */}
      <Link href="/documents/new" aria-label="Add document" className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-[9px] bg-accent px-3 py-2 font-medium text-white hover:bg-[#264d8f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-3.5">
        <span aria-hidden>+</span><span aria-hidden className="hidden sm:inline">Add document</span>
      </Link>
      <details className="relative">
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
