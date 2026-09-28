import { notFound } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { istDate } from "@/lib/documents/period";
import { getDocumentForForm, listGroups, listPeriods, typesForClient } from "@/lib/documents/queries";
import { PageHeader } from "@/components/ui";
import { DocumentForm } from "../../new/document-form";

/**
 * Inbox › Assign (spec AC-8): the Add document form with what is known. Saving with client + type files it
 * (classified_at is set the first time). RLS: a document the user can't see is Not Found (AC-12).
 */
export default async function AssignDocumentPage({ params }: PageProps<"/documents/[id]/assign">) {
  const { id } = await params;
  const me = await requireStaff();
  if (!z.uuid().safeParse(id).success) notFound();
  const doc = await getDocumentForForm(id);
  if (!doc || doc.archived) notFound();
  const [types, periods, groups] = await Promise.all([typesForClient(doc.client?.id ?? null), listPeriods(), listGroups()]);
  return (
    <div className="mx-auto max-w-[815px]">
      <PageHeader title={doc.classified ? "Edit document" : "Assign document"} subtitle={doc.classified ? undefined : "Add the client and type to file it in the vault."} />
      <DocumentForm existing={doc} initialClient={doc.client} initialTypes={types} periods={periods} groups={groups}
        today={istDate()} canPropose={me.role !== "limited"} returnTo={doc.classified ? `/documents/${doc.id}` : "/inbox"} />
    </div>
  );
}
