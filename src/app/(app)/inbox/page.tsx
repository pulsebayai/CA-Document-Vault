import { requireStaff } from "@/lib/auth/staff";
import { listInbox, toReviewCount } from "@/lib/documents/queries";
import { InboxView } from "./inbox-view";

/** Inbox (mockup 02, spec AC-7 … AC-9). RLS: Staff+ see every item; Limited only what they added. */
export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const me = await requireStaff();
  const sp = await searchParams;
  const saved = typeof sp.saved === "string" && /^DOC-FY\d{2}-\d{2}-\d{5,}$/.test(sp.saved) ? sp.saved : null;
  const [items, toReview] = await Promise.all([listInbox(me.role === "limited" ? me.id : null), toReviewCount()]);
  return <InboxView items={items} now={new Date()} saved={saved} toReview={toReview} />;
}
