import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui";

// 19: small server-side pieces shared by the Platform screens (no mockup: follows Settings › Users' table style).

const IST = "Asia/Kolkata";
export const dateTime = (at: string | null | undefined) =>
  at ? new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at)) : "—";
export const date = (at: string | null | undefined) =>
  at ? new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", year: "numeric" }).format(new Date(at)) : "—";
export const words = (v: string | null | undefined) => (v ? v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");
export const size = (bytes: number | null | undefined) =>
  bytes == null ? "—" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
export const pageOf = (v: string | string[] | undefined) => Math.max(1, Math.min(10_000, Number.parseInt(String(v ?? "1"), 10) || 1));

/** A table in a card; scrolls inside its own box on phones (relative, so sr-only text can't escape — 02). */
export function DataTable({ caption, head, children, empty }: { caption: string; head: string[]; children: ReactNode; empty?: boolean }) {
  return (
    <Card>
      {/* focusable and named, so keyboard users can scroll it on a phone (axe scrollable-region-focusable) */}
      <div className="relative overflow-x-auto focus-visible:outline-2 focus-visible:outline-accent" tabIndex={0} role="region" aria-label={caption}>
        <table className="w-full min-w-[640px] text-left text-[13.5px]">
          <caption className="sr-only">{caption}</caption>
          <thead className="text-[13px] text-ink-3">
            <tr className="border-b border-line">
              {head.map((h, i) => <th key={h} scope="col" className={`${i === 0 ? "px-5" : "px-3"} py-3 font-normal`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {empty && <p className="px-5 py-6 text-ink-3">Nothing here yet.</p>}
    </Card>
  );
}

export const Td = ({ children, first, className = "" }: { children: ReactNode; first?: boolean; className?: string }) =>
  <td className={`${first ? "px-5" : "px-3"} py-3 ${className}`}>{children}</td>;

/** Previous / Next as links (page numbers only in the URL). */
export function Pager({ base, page, hasNext, extra = "" }: { base: string; page: number; hasNext: boolean; extra?: string }) {
  if (page <= 1 && !hasNext) return null;
  const href = (p: number) => `${base}?page=${p}${extra}`;
  const cls = "rounded-[7px] border border-line-2 bg-panel px-2.5 py-1 hover:bg-canvas";
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-end gap-2 text-[13.5px]">
      {page > 1 ? <Link prefetch={false} className={cls} href={href(page - 1)}>Previous</Link> : null}
      <span className="text-ink-3">Page {page}</span>
      {hasNext ? <Link prefetch={false} className={cls} href={href(page + 1)}>Next</Link> : null}
    </nav>
  );
}

/** Shown by a read view when there is no open window for this firm (the database refused: NO_ACCESS). */
export function NoAccess({ firmId }: { firmId: string }) {
  return (
    <Card className="px-6 py-8">
      <p role="alert" className="font-medium">Read access to this firm isn&apos;t open.</p>
      <p className="mt-1 text-ink-2">Open read access with a reason on the firm page. It lasts 60 minutes, and the firm&apos;s Admins are told.</p>
      <Link prefetch={false} href={`/platform/firms/${firmId}`} className="mt-4 inline-block font-medium text-accent underline-offset-2 hover:underline">Go to the firm page</Link>
    </Card>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="mt-0.5">{children ?? "—"}</dd>
    </div>
  );
}

export function Back({ href, children }: { href: string; children: ReactNode }) {
  return <Link prefetch={false} href={href} className="mb-3 inline-block text-[13.5px] text-ink-2 hover:text-ink">← {children}</Link>;
}
