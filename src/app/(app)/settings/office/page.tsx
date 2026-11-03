import { requireAdmin } from "@/lib/auth/staff";
import { saveOffice } from "@/lib/office/actions";
import { Card } from "@/components/ui";
import { OfficeForm } from "./office-form";

/** Feature 17 (spec AC-9, AC-10). Admin only (others get 404). No mockup: follows Settings › Users' form style. */
export default async function OfficePage() {
  const me = await requireAdmin();
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Office</h2>
        <p className="mt-0.5 text-[13.5px] text-ink-3">Admin only</p>
      </div>
      <Card className="p-6">
        <p className="mb-4 max-w-prose text-[13.5px] text-ink-2">
          Your firm&apos;s name appears on the vault header, as the sender of emails to clients, and on client upload pages.
        </p>
        <OfficeForm name={me.officeName} branch={me.officeBranch} action={saveOffice} />
      </Card>
    </div>
  );
}
