import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { collectionMetricAs, todayForOffice } from "@/lib/expected/queries";
import { addDays, shortDate } from "@/lib/expected/schedule";
import { onTimePct, pctText } from "@/lib/expected/shape";
import { Card } from "@/components/ui";
import { chasingMetricAs } from "@/lib/reminders/queries";
import { catalogueMetricAs, formatMetricAs } from "@/lib/catalogue/queries";
import { sharePct } from "@/lib/validation/formats";
import { linkMetricAs } from "@/lib/upload-links/queries";

// Feature 04 step 8 — Settings › Collection (spec AC-16, architecture change 5): product metric 1 (on-time
// completeness) for the last 30 days, per group, plus "Overdue now" and when the daily job last ran.
// Admin/Manager only: others get no Settings item and Not Found here; collection_metric re-checks the role.
// Feature 06 (AC-15): product metric 2, chasing load, for the same window (chasing_metric re-checks the role too).
// Feature 05 (AC-16): product metric 3, catalogue convergence, as of now, plus the proposal queue's age.
// Feature 10 (AC-23): upload links — share received by link, time to review, corrections, ad-hoc turnaround.
// Feature 11 (AC-24): preferred formats — share filed in a preferred format, warned link uploads, review time, exceptions.

const WINDOW_DAYS = 30;
const stamp = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export default async function CollectionPage() {
  const me = await requireStaff();
  if (!canManageCatalogue(me.role)) notFound();
  const today = await todayForOffice(me.officeId);
  const from = addDays(today, -(WINDOW_DAYS - 1));
  const [m, chase, cat, link, fmt] = await Promise.all([
    collectionMetricAs(from, today), chasingMetricAs(from, today), catalogueMetricAs(), linkMetricAs(from, today), formatMetricAs(from, today),
  ]);
  const { link: fLink, staff: fStaff } = fmt.applied;
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
        {/* Nothing fell due in the window: only "Overdue now" means anything (review nit 5). */}
        {tiles.filter(([label]) => m.due > 0 || label === "Overdue now").map(([label, value, note]) => (
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

      <section aria-labelledby="chasing-h" className="space-y-3">
        <h3 id="chasing-h" className="font-semibold">Chasing load</h3>
        {chase.received === 0 ? (
          <Card className="px-6 py-5"><p className="font-medium">No expected documents were received in these {WINDOW_DAYS} days.</p></Card>
        ) : (
          <dl aria-label="Chasing load figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {([
              ["Reminders per document", chase.per_item === null ? "—" : chase.per_item.toFixed(2), `${chase.reminders} reminders`],
              ["Needed a reminder", pctText(chase.needed_pct), `of ${chase.received} received`],
              ["Received", String(chase.received)],
              ["By email", String(chase.by_channel.email)],
              ["By WhatsApp", String(chase.by_channel.whatsapp)],
              ["By call", String(chase.by_channel.phone)],
            ] as Array<[string, string, string?]>).map(([label, value, note]) => (
              <Card key={label} className="px-4 py-3">
                <dt className="text-[13px] text-ink-3">{label}</dt>
                <dd className="mt-1 text-[22px] font-semibold leading-tight">{value}</dd>
                {note && <dd className="text-[12.5px] text-ink-3">{note}</dd>}
              </Card>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="catalogue-h" className="space-y-3">
        <h3 id="catalogue-h" className="font-semibold">Catalogue</h3>
        <dl aria-label="Catalogue figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Card className="px-4 py-3">
            <dt className="text-[13px] text-ink-3">Filed under approved types</dt>
            <dd className="mt-1 text-[22px] font-semibold leading-tight">{pctText(cat.approvedPct)}</dd>
            <dd className="text-[12.5px] text-ink-3">{cat.total ? `${cat.approved} of ${cat.total} documents` : "no filed documents yet"}</dd>
          </Card>
        </dl>
        <p className="text-[13.5px] text-ink-2">
          {cat.waiting === 0 ? "No proposals waiting." : (
            <>
              <Link href="/settings/catalogue" className="text-accent hover:underline">{cat.waiting} {cat.waiting === 1 ? "proposal" : "proposals"} waiting</Link>
              {cat.oldestDays !== null && <> · oldest {cat.oldestDays} {cat.oldestDays === 1 ? "day" : "days"}</>}
            </>
          )}
        </p>
      </section>

      <section aria-labelledby="links-h" className="space-y-3">
        <h3 id="links-h" className="font-semibold">Upload links</h3>
        {link.via_link === 0 && link.adhoc_received === 0 ? (
          <Card className="px-6 py-5"><p className="font-medium">No documents came through upload links in these {WINDOW_DAYS} days.</p></Card>
        ) : (
          <dl aria-label="Upload link figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {([
              ["Received through links", pctText(link.link_pct), `${link.via_link} of ${link.documents} documents`],
              ["Hours to first review", link.review_median_hours === null ? "—" : String(link.review_median_hours), link.reviewed ? `median of ${link.reviewed}` : "none reviewed yet"],
              ["Needed correcting", pctText(link.needs_fix_pct), link.via_link ? `${link.needs_fix} of ${link.via_link} link uploads` : undefined],
              ["Days to receive a request", link.adhoc_median_days === null ? "—" : String(link.adhoc_median_days), link.adhoc_received ? `median of ${link.adhoc_received}` : "none received yet"],
              ["Received by needed-by", pctText(link.adhoc_on_time_pct), link.adhoc_with_date ? `${link.adhoc_on_time} of ${link.adhoc_with_date} with a date` : undefined],
            ] as Array<[string, string, string?]>).map(([label, value, note]) => (
              <Card key={label} className="px-4 py-3">
                <dt className="text-[13px] text-ink-3">{label}</dt>
                <dd className="mt-1 text-[22px] font-semibold leading-tight">{value}</dd>
                {note && <dd className="text-[12.5px] text-ink-3">{note}</dd>}
              </Card>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="formats-h" className="space-y-3">
        <h3 id="formats-h" className="font-semibold">Preferred formats</h3>
        {fLink.total === 0 && fStaff.total === 0 ? (
          <Card className="px-6 py-5"><p className="font-medium">No documents were filed where a preferred format applied in these {WINDOW_DAYS} days.</p></Card>
        ) : (
          <dl aria-label="Preferred format figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {([
              ["Link uploads in a preferred format", pctText(sharePct(fLink.preferred, fLink.total)), fLink.total ? `${fLink.preferred} of ${fLink.total} link uploads` : "no link uploads"],
              ["Staff filings in a preferred format", pctText(sharePct(fStaff.preferred, fStaff.total)), fStaff.total ? `${fStaff.preferred} of ${fStaff.total} staff filings` : "no staff filings"],
              ["Warned, then sent a preferred file", pctText(sharePct(fmt.warned.switched, fmt.warned.total)), fmt.warned.total ? `${fmt.warned.switched} of ${fmt.warned.total} warned` : "no warnings shown"],
              ["Warned, uploaded anyway", String(fmt.warned.anyway)],
              ["Hours to review a flagged upload", fmt.flagged_review_hours_median === null ? "—" : String(fmt.flagged_review_hours_median), "median, link uploads"],
            ] as Array<[string, string, string?]>).map(([label, value, note]) => (
              <Card key={label} className="px-4 py-3">
                <dt className="text-[13px] text-ink-3">{label}</dt>
                <dd className="mt-1 text-[22px] font-semibold leading-tight">{value}</dd>
                {note && <dd className="text-[12.5px] text-ink-3">{note}</dd>}
              </Card>
            ))}
          </dl>
        )}
        <div>
          <h4 className="text-[13.5px] font-medium">Clients allowed any format (top 5 types, as of now)</h4>
          {fmt.exceptions.length === 0 ? (
            <p className="mt-1 text-[13.5px] text-ink-2">No client exceptions.</p>
          ) : (
            <ul aria-label="Clients allowed any format, by type" className="mt-1 space-y-0.5 text-[13.5px]">
              {fmt.exceptions.map((e) => (
                <li key={e.type_id}><span className="font-medium">{e.type}</span> · {e.n} {e.n === 1 ? "client" : "clients"}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <div role="note" className="space-y-1 text-[13.5px] text-ink-2">
        <p>
          <strong className="font-medium text-ink">How it&apos;s counted.</strong> Expected documents whose overdue date fell in the
          last {WINDOW_DAYS} days. <em>On time</em> = received before the overdue date. Items marked not needed, items on hold
          and archived clients are left out. <em>Overdue now</em> counts every open item past its overdue date, whenever it fell due.
        </p>
        <p>
          <strong className="font-medium text-ink">Chasing load.</strong> Expected documents received in the last {WINDOW_DAYS} days.
          A reminder counts for a document when it included that document and was sent, opened in WhatsApp or logged as a call
          on or before the day it was received. Failed emails don&apos;t count; a WhatsApp chat counts when opened (the vault
          can&apos;t see whether it was sent).
        </p>
        <p>
          <strong className="font-medium text-ink">Catalogue.</strong> Filed, non-archived documents whose type is approved,
          out of all filed, non-archived documents, as of now (not the last {WINDOW_DAYS} days). Proposed types count until
          they are approved or merged.
        </p>
        <p>
          <strong className="font-medium text-ink">Upload links.</strong> Filed documents added in the last {WINDOW_DAYS} days,
          and requested (ad-hoc) documents received in them. <em>Hours to first review</em> runs from the client&apos;s upload to
          the first Reviewed or Needs correction. <em>Needed correcting</em> = marked Needs correction, or re-filed under another
          client or type. Requested documents never count in the on-time figure above.
        </p>
        <p>
          <strong className="font-medium text-ink">Preferred formats.</strong> Filed documents added in the last {WINDOW_DAYS} days
          whose type had preferred formats for that client when filed (clients allowed any format are left out).
          <em> Warned</em> = the upload page showed the client the format warning before the upload. <em>Hours to review</em> runs
          from a flagged link upload to its first Reviewed or Needs correction. Nothing is ever refused for its format.
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
