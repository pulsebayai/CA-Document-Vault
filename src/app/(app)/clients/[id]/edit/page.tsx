import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { updateClientAction } from "@/lib/clients/actions";
import { getClient, listStaffOptions } from "@/lib/clients/queries";
import { PageHeader } from "@/components/ui";
import { ClientForm } from "../../client-form";

/** Edit client (spec AC-10). Staff+; incharge only for Admin/Manager; archived clients must be unarchived first. */
export default async function EditClientPage({ params }: PageProps<"/clients/[id]/edit">) {
  const { id } = await params;
  const me = await requireStaff();
  if (me.role === "limited" || !z.uuid().safeParse(id).success) notFound();
  const client = await getClient(id);
  if (!client) notFound();
  if (client.archived) redirect(`/clients/${id}`);
  const staff = await listStaffOptions();
  // Keep a deactivated incharge selectable-as-is so the form doesn't silently change it.
  const options = staff.some((s) => s.id === client.inchargeId) ? staff : [{ id: client.inchargeId, name: client.inchargeName }, ...staff];
  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title={`Edit ${client.name}`} subtitle={`Client code ${client.code}`} />
      <ClientForm action={updateClientAction} staff={options} client={client} defaultInchargeId={client.inchargeId}
        canChangeIncharge={canManageCatalogue(me.role)} cancelHref={`/clients/${id}?tab=settings`} />
    </div>
  );
}
