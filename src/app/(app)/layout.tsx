import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth/staff";
import { AppHeader } from "@/components/app-header";
import { inboxCount } from "@/lib/documents/queries";
import { unreadNotificationCount } from "@/lib/notifications/queries";

export const dynamic = "force-dynamic";

/** The signed-in staff member's own firm in the tab title (17: never another firm's name). */
export async function generateMetadata(): Promise<Metadata> {
  const me = await requireStaff(); // cached per request: the layout below asks the same
  return { title: me.officeName };
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  const [count, unread] = await Promise.all([inboxCount(me.role === "limited" ? me.id : null), unreadNotificationCount()]);
  return (
    <>
      <AppHeader me={me} inboxCount={count} unreadNotifications={unread} />
      <main className="px-6 py-7">{children}</main>
    </>
  );
}
