import { requireStaff } from "@/lib/auth/staff";
import { PageHeader } from "@/components/ui";
import { SettingsNav } from "./settings-nav";

/**
 * Settings shell (mockups 05/06): left sub-nav + content. The catalogue is readable by all staff
 * (spec 02 AC-6); Users and roles stays Admin only (01 AC-10). Only shipped screens are listed.
 */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const me = await requireStaff();
  const items = [{ href: "/settings/catalogue", label: "Document catalogue" }];
  if (me.role === "admin") items.push({ href: "/settings/users", label: "Users and roles" });
  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title="Settings" subtitle="Office-wide" />
      <div className="grid gap-6 md:grid-cols-[210px_minmax(0,1fr)]">
        <SettingsNav items={items} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
