import { requireStaff } from "@/lib/auth/staff";
import { AppHeader } from "@/components/app-header";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  return (
    <>
      <AppHeader me={me} />
      <main className="px-6 py-7">{children}</main>
    </>
  );
}
