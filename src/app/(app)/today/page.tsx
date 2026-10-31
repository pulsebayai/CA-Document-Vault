import { requireStaff } from "@/lib/auth/staff";
import { inboxCount } from "@/lib/documents/queries";
import { parseTodayParams } from "@/lib/today/shape";
import { todayDataAs } from "@/lib/today/queries";
import { TodayView } from "./today-view";
import { dscDue } from "@/lib/dsc/queries";
import { DscDueSection } from "./dsc-due-section";

/**
 * Today — the landing page (mockup 01, spec 06 AC-1…AC-5). Scope and the count filter are enums in the URL
 * (`?scope=everyone&show=overdue`); everything else comes from today_items() under RLS.
 * To review / Ready to dispatch join after 07 merges (plan step 9).
 */
export default async function TodayPage({ searchParams }: PageProps<"/today">) {
  const me = await requireStaff();
  const params = parseTodayParams(await searchParams);
  const [data, inbox, dsc] = await Promise.all([
    todayDataAs(params.scope, params.show, params.page),
    inboxCount(me.role === "limited" ? me.id : null),
    dscDue(params.scope), // 14 AC-11: its own call; today_items untouched (T2)
  ]);
  return <TodayView data={data} inbox={inbox} scope={params.scope} show={params.show} page={params.page}
    dsc={<DscDueSection count={dsc.count} rows={dsc.rows} today={data.today} />} />;
}
