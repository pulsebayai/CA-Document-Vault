import { requireStaff } from "@/lib/auth/staff";
import { AppHeader } from "@/components/app-header";
import { inboxCount } from "@/lib/documents/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  const count = await inboxCount();
  return (
    <>
      <AppHeader me={me} inboxCount={count} />
      <main className="px-6 py-7">{children}</main>
    </>
  );
}
