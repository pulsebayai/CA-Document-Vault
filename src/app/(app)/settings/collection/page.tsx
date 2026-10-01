import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { collectionMetricAs, todayForOffice } from "@/lib/expected/queries";
import { addDays, shortDate } from "@/lib/expected/schedule";
import { onTimePct, pctText } from "@/lib/expected/shape";
import { Card } from "@/components/ui";

// Feature 04 step 8 — Settings › Collection (spec AC-16, architecture change 5): product metric 1 (on-time
// completeness) for the last 30 days, per group, plus "Overdue now" and when the daily job last ran.
// Admin/Manager only: others get no Settings item and Not Found here; collection_metric re-checks the role.

const WINDOW_DAYS = 30;
const stamp = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export default async function CollectionPage() {
  const me = await requireStaff();
  if (!canManageCatalogue(me.role)) notFound();
  const today = await todayForOffice(me.officeId);
  const from = addDays(today, -(WINDOW_DAYS - 1));
  const m = await collectionMetricAs(from, today);
  const tiles: Array<[string, string, string?]> = [
    ["On time", pctText(m.on_time_pct), m.due ? `of ${m.due} due` : undefined],
    ["Received on time", String(m.on_time)],
    ["Received late", String(m.late)],
    ["Still missing", String(m.missing)],
    ["Overdue now", String(m.overdue_now), "all dates"],
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Collection</h2>
        <p className="mt-0.5 text-[13.5px] text-ink-3">
          Last {WINDOW_DAYS} days ({shortDate(from, today)} – {shortDate(today, today)}) · Admin and Manager
        </p>
      </div>

      {m.due === 0 && (
        <Card className="px-6 py-6">
          <p className="font-medium">Nothing has fallen due yet — the figure appears after the first overdue date.</p>
        </Card>
      )}

      <dl aria-label="Collection figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(([label, value, note]) => (
          <Card key={label} className="px-4 py-3">
            <dt className="text-[13px] text-ink-3">{label}</dt>
            <dd className="mt-1 text-[22px] font-semibold leading-tight">{value}</dd>
            {note && <dd className="text-[12.5px] text-ink-3">{note}</dd>}
          </Card>
        ))}
      </dl>

      {m.groups.length > 0 && (
        <Card>
          {/* Scrolls sideways on a phone: focusable + named, so keyboard users can scroll it (axe scrollable-region-focusable). */}
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="On-time collection by group">
            <table className="w-full text-left text-[14px]">
              <caption className="sr-only">On-time collection by group, last {WINDOW_DAYS} days</caption>
              <thead className="text-[13px] text-ink-3">
                <tr>
                  <th scope="col" className="px-5 py-2 font-medium">Group</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Due</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">On time</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Late</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Missing</th>
                  <th scope="col" className="px-5 py-2 text-right font-medium">On-time %</th>
                </tr>
              </thead>
              <tbody>
                {m.groups.map((g) => (
                  <tr key={g.doc_group_id} className="border-t border-line">
                    <th scope="row" className="px-5 py-2.5 font-medium">{g.name}</th>
                    <td className="px-3 py-2.5 text-right">{g.due}</td>
                    <td className="px-3 py-2.5 text-right">{g.on_time}</td>
                    <td className="px-3 py-2.5 text-right">{g.late}</td>
                    <td className="px-3 py-2.5 text-right">{g.missing}</td>
                    <td className="px-5 py-2.5 text-right">{pctText(onTimePct(g))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div role="note" className="space-y-1 text-[13.5px] text-ink-2">
        <p>
          <strong className="font-medium text-ink">How it&apos;s counted.</strong> Expected documents whose overdue date fell in the
          last {WINDOW_DAYS} days. <em>On time</em> = received before the overdue date. Items marked not needed, items on hold
          and archived clients are left out. <em>Overdue now</em> counts every open item past its overdue date, whenever it fell due.
        </p>
        <p>
          Expected documents last generated:{" "}
          {m.last_generated_at
            ? <span className="text-ink">{stamp.format(new Date(m.last_generated_at))}</span>
            : <span className="font-medium text-bad">never — the daily job hasn&apos;t run for this office</span>}
        </p>
      </div>
    </div>
  );
}
