import { describeActivity, timeOfDay, dayHeading } from "@/lib/activity-feed/catalogue";
import { viewActivity } from "@/lib/platform/queries";
import { Card } from "@/components/ui";
import { NoAccess, Pager, pageOf } from "../../../ui";

export const dynamic = "force-dynamic";

/** 19 (spec Y5): the firm's activity, newest first (sign-ins left out), with 08's sentences. IDs and names only. */
export default async function PlatformActivityPage({ params, searchParams }: PageProps<"/platform/firms/[id]/activity">) {
  const { id } = await params;
  const page = pageOf((await searchParams).page);
  const r = await viewActivity(id, page);
  if (!r.ok) return <NoAccess firmId={id} />;
  const rows = r.data.rows;
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Activity</h2>
      <Card>
        <ul>
          {rows.map((a) => {
            const { sentence } = describeActivity({ action: a.action, actor_name: a.actor_name, client_name: null, doc_code: null, doc_type_name: null, doc_group_name: null, data: a.data ?? {} });
            return (
              <li key={a.id} className="flex flex-wrap gap-x-4 border-b border-line px-5 py-3 text-[13.5px] last:border-0">
                <span className="w-44 shrink-0 text-ink-3">{dayHeading(a.created_at)} · {timeOfDay(a.created_at)}</span>
                <span>{sentence}</span>
              </li>
            );
          })}
          {rows.length === 0 && <li className="px-5 py-6 text-ink-3">No activity yet.</li>}
        </ul>
      </Card>
      <Pager base={`/platform/firms/${id}/activity`} page={page} hasNext={rows.length === 50} />
    </div>
  );
}
