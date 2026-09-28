import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { createClientAction } from "@/lib/clients/actions";
import { listGroupOptions, listStaffOptions } from "@/lib/clients/queries";
import { PageHeader } from "@/components/ui";
import { ClientForm } from "../client-form";

/** Add client (spec AC-8). Staff+; Limited users get Not Found. On save → the client's page. */
export default async function NewClientPage() {
  const me = await requireStaff();
  if (me.role === "limited") notFound();
  const [staff, groups] = await Promise.all([listStaffOptions(), listGroupOptions()]);
  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title="Add client" subtitle="The vault assigns the client code when you save." />
      <ClientForm action={createClientAction} staff={staff} groups={groups} defaultInchargeId={me.id} canChangeIncharge cancelHref="/clients" />
    </div>
  );
}
