import Link from "next/link";
import { Card } from "@/components/ui";
import { ACTIVITY_CATALOGUE } from "@/lib/activity-feed/catalogue";
import type { FeedResult, FeedRow } from "@/lib/activity-feed/queries";

// Feature 08 AC-10 — the document page's Activity card: this document's events (its own rows and the dispatch rows
// naming it), newest first, 20, then "See all in Activity". Read through activity_feed, so the viewer's RLS applies.
// The wording for the document's own events is unchanged from 03/07 (it reads "<who> <did what>" about this page).

export const CARD_LIMIT = 20;

const ON_THIS_PAGE: Record<string, string> = {
  "document.added": "added", "document.classified": "filed (client/type)", "document.updated": "edited",
  "document.version_added": "uploaded a new version", "document.archived": "archived", "document.unarchived": "unarchived",
  "document.reviewed": "marked it reviewed", "document.needs_correction": "marked it as needing correction",
  "document.review_undone": "undid the review",
};
const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function cardText(r: FeedRow): string {
  const known = ON_THIS_PAGE[r.action];
  if (known) return known;
  const entry = ACTIVITY_CATALOGUE[r.action];
  return entry ? entry.text(r) : r.action;
}

export function ActivityCard({ documentId, feed }: { documentId: string; feed: FeedResult }) {
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Activity</h2>
      {!feed.ok ? (
        <p role="alert" className="mt-2 text-[13.5px] text-bad">{feed.error}</p>
      ) : feed.page.rows.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-ink-2">No activity yet.</p>
      ) : (
        <ul aria-label="Document activity" className="mt-2 space-y-1.5 text-[13.5px]">
          {feed.page.rows.map((a) => (
            <li key={a.id}>
              <span className="font-medium">{a.actor_name ?? "Vault"}</span> {cardText(a)} <span className="text-ink-3">· {when.format(new Date(a.at))}</span>
            </li>
          ))}
        </ul>
      )}
      <Link href={`/activity?document=${documentId}`} className="mt-3 inline-block text-[13.5px] font-medium text-accent hover:underline">See all in Activity</Link>
    </Card>
  );
}
