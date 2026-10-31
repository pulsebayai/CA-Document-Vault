import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { custodyText, expiryStatus, shortDate } from "@/lib/dsc/expiry";
import type { DueDsc } from "@/lib/dsc/queries";
import { dscClassLabel } from "@/lib/validation/dsc";

// Feature 14 AC-11 (T2, T3) — Today's "DSC expiring": live DSCs expiring within their client's remind days, or expired,
// soonest first. Mine = clients I'm incharge of. Nothing is sent to clients (Q4). Hidden when there are none.
export function DscDueSection({ count, rows, today }: { count: number; rows: DueDsc[]; today: string }) {
  if (count === 0) return null;
  return (
    <section aria-labelledby="dsc-due-title" className="mb-5">
      <Card className="p-5">
        <h2 id="dsc-due-title" className="font-semibold">
          DSC expiring <span className="ml-1 font-normal text-ink-3">{count}</span>
        </h2>
        <ul className="mt-3 divide-y divide-line">
          {rows.map((r) => {
            const s = expiryStatus(r.expiresOn, today, r.remindDays);
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[14px]">
                <div className="min-w-0">
                  <Link href={`/clients/${r.clientId}?tab=dsc`} className="font-medium text-accent hover:underline">{r.clientName}</Link>
                  <span className="text-ink-3"> · {r.clientCode}</span>
                  <p className="break-words text-[13.5px] text-ink-2">
                    {r.holderName}{r.dscClass ? ` · ${dscClassLabel(r.dscClass)}` : ""} · expiry {shortDate(r.expiresOn)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={s.tone}>{s.text}</Badge>
                  <Badge tone={r.outTo ? "warn" : "muted"}>
                    {custodyText(r.outTo && r.outSince ? { direction: "out", person_name: r.outTo, on_date: r.outSince } : null)}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
        {count > rows.length && <p className="mt-2 text-[13px] text-ink-3">Showing the first {rows.length} of {count}.</p>}
      </Card>
    </section>
  );
}
