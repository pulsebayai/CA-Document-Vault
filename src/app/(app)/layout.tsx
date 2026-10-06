import { requireStaff } from "@/lib/auth/staff";
import { AppHeader } from "@/components/app-header";
import { inboxCount } from "@/lib/documents/queries";
import { unreadNotificationCount } from "@/lib/notifications/queries";

export const dynamic = "force-dynamic";

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
