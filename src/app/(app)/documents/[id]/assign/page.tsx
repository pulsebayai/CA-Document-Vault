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
export default async function AssignDocumentPage({ params, searchParams }: PageProps<"/documents/[id]/assign">) {
  const { id } = await params;
  const sp = await searchParams;
  const me = await requireStaff();
  if (!z.uuid().safeParse(id).success) notFound();
  const doc = await getDocumentForForm(id);
  if (!doc || doc.archived) notFound();
  const [types, periods, groups] = await Promise.all([typesForClient(doc.client?.id ?? null), listPeriods(), listGroups()]);
  return (
    <div className="mx-auto max-w-[815px]">
      <PageHeader title={doc.classified ? "Edit document" : "Assign document"} subtitle={doc.classified ? undefined : "Add the client and type to file it in the vault."} />
      <DocumentForm existing={doc} initialClient={doc.client} initialTypes={types} periods={periods} groups={groups}
        today={istDate()} canPropose={me.role !== "limited"} returnTo={safeReturn(sp.from) ?? (doc.classified ? `/documents/${doc.id}` : "/inbox")} />
    </div>
  );
}

/** 12 (AC-19): Edit from a client's Documents returns there. Only our own client pages; never an arbitrary URL. */
function safeReturn(from: string | string[] | undefined): string | null {
  const f = typeof from === "string" ? from : "";
  return /^\/clients\/[0-9a-f-]{36}$/.test(f) ? f : null;
}
