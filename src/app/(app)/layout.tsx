import { requireStaff } from "@/lib/auth/staff";
import { AppHeader } from "@/components/app-header";
import { inboxCount } from "@/lib/documents/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  const count = await inboxCount(me.role === "limited" ? me.id : null);
  return (
    <>
      <AppHeader me={me} inboxCount={count} />
      <main className="px-6 py-7">{children}</main>
    </>
  );
}
