import { requireAdmin } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/auth/roles";
import { PERMISSIONS, cellText } from "@/lib/auth/permissions";
import { Badge, Card } from "@/components/ui";
import { InviteDialog } from "./invite-dialog";
import { StaffRowActions } from "./staff-row-actions";

type Row = { id: string; full_name: string; email: string; role: Role; status: "invited" | "active" | "deactivated" };

// 08 AC-12: the matrix comes from src/lib/auth/permissions.ts, the same rows tests/rls/role-matrix.test.ts probes.
const COLUMN: Record<Role, string> = { admin: "Admin", manager: "Manager", staff: "Staff", limited: "Limited" };

/** Mockup 06-settings-users.jpg. Admin only (others get 404 — spec AC-10). */
export default async function UsersPage() {
  const me = await requireAdmin();
  const supabase = await createClient();
  const { data } = await supabase.from("staff_user").select("id, full_name, email, role, status").order("created_at");
  const rows = (data ?? []) as Row[];
  const activeAdmins = rows.filter((r) => r.role === "admin" && r.status === "active").length;

  return (
    <div>
      {/* Page title "Settings" comes from settings/layout.tsx; this section is Admin only. */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Users and roles</h2>
          <p className="mt-0.5 text-[13.5px] text-ink-3">Admin only</p>
        </div>
        <InviteDialog />
      </div>
      <Card>
        <table className="w-full text-left">
          <caption className="sr-only">Staff with access to the vault</caption>
          <thead className="text-[13px] text-ink-3">
            <tr className="border-b border-line">
              <th scope="col" className="px-5 py-3 font-normal">Person</th>
              <th scope="col" className="px-3 py-3 font-normal">Email</th>
              <th scope="col" className="px-3 py-3 font-normal">Role</th>
              <th scope="col" className="px-3 py-3 font-normal">Status</th>
              <th scope="col" className="px-5 py-3 font-normal"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const lastAdmin = r.role === "admin" && r.status === "active" && activeAdmins <= 1;
              return (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-3 font-medium">{r.full_name}{r.id === me.id && <span className="ml-1.5 text-[13px] font-normal text-ink-3">(you)</span>}</td>
                  <td className="px-3 py-3 text-[13.5px] text-ink-2">{r.email}</td>
                  <td className="px-3 py-3 text-[13.5px]">{ROLE_LABEL[r.role]}</td>
                  <td className="px-3 py-3">
                    {r.status === "active" && <Badge tone="ok">Active</Badge>}
                    {r.status === "invited" && <Badge tone="warn">Invited</Badge>}
                    {r.status === "deactivated" && <Badge tone="muted">Deactivated</Badge>}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <StaffRowActions id={r.id} name={r.full_name} role={r.role} status={r.status} lastAdmin={lastAdmin} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <h2 className="mb-3 mt-8 font-semibold">What each role can do</h2>
      <Card>
        {/* Wide on phones: scrolls inside its own box (relative, so sr-only text can't escape — 02). */}
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[13.5px]">
            <caption className="sr-only">What each role can do</caption>
            <thead className="text-[13px] text-ink-3">
              <tr className="border-b border-line">
                <th scope="col" className="px-5 py-3 font-normal"><span className="sr-only">Permission</span></th>
                {ROLES.map((r) => <th key={r} scope="col" className="px-3 py-3 text-center font-normal">{COLUMN[r]}</th>)}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-5 py-2.5 font-normal">{row.label}</th>
                  {ROLES.map((r) => (
                    <td key={r} className={`px-3 py-2.5 text-center ${row.values[r] === "no" ? "text-ink-3" : "text-ok"}`}>{cellText(row, r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-2 text-[13px] text-ink-3">The database enforces every cell, and each one is tested per role. &quot;Delete&quot; in the original design is archive: reversible and logged.</p>
    </div>
  );
}
