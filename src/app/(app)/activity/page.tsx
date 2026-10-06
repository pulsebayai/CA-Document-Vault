import { requireStaff } from "@/lib/auth/staff";
import { activityQuery, parseActivityParams } from "@/lib/activity-feed/filters";
import { feedOptions, loadFeed } from "@/lib/activity-feed/queries";
import { ActivityView } from "./activity-view";

// Feature 08 AC-5 … AC-11 — /activity (mockup 04), for every staff member. What each person sees is decided by the
// activity_select policy (Limited: their own actions and their clients' events); the filters come from the URL.
export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const me = await requireStaff();
  const filters = parseActivityParams(await searchParams);
  const [initial, options] = await Promise.all([loadFeed(filters), feedOptions(filters)]);
  return (
    // A new filter set starts a fresh list (the client state holds pages loaded with "Load earlier").
    <ActivityView key={activityQuery(filters)} filters={filters} options={options} initial={initial}
      limited={me.role === "limited"} isAdmin={me.role === "admin"} now={new Date().toISOString()} />
  );
}
