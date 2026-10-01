import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { istDate } from "@/lib/documents/period";
import { clientOption, listGroups, listPeriods, typesForClient } from "@/lib/documents/queries";
import { prefillFrom } from "@/lib/expected/prefill";
import { PageHeader } from "@/components/ui";
import { DocumentForm } from "./document-form";

/**
 * Add document (mockup 12, spec AC-1 … AC-5). Everyone signed in (Limited too: their clients or the Inbox).
 * ?client=<uuid> pre-fills the client (from a client page); ?from= is where to go back to (internal paths only).
 * From an expected row (04 AC-8): ?type=&period=&registration= (UUIDs) pre-fill the rest, kept only if valid for the client.
 */
export default async function NewDocumentPage({ searchParams }: PageProps<"/documents/new">) {
  const me = await requireStaff();
  const sp = await searchParams;
  const clientParam = typeof sp.client === "string" && z.uuid().safeParse(sp.client).success ? sp.client : null;
  const client = clientParam ? await clientOption(clientParam) : null;
  const [types, periods, groups] = await Promise.all([typesForClient(client?.id ?? null), listPeriods(), listGroups()]);
  const prefill = client ? prefillFrom(sp, types, periods) : null;
  return (
    <div className="mx-auto max-w-[815px]">
      <PageHeader title="Add document" />
      <DocumentForm initialClient={client} initialTypes={types} periods={periods} groups={groups} today={istDate()}
        canPropose={me.role !== "limited"} returnTo={safeReturn(sp.from, client?.id)} prefill={prefill} />
    </div>
  );
}

/** Only our own list/detail pages; never an arbitrary URL (open redirect). */
function safeReturn(from: string | string[] | undefined, clientId: string | undefined): string {
  const f = typeof from === "string" ? from : "";
  if (/^\/clients\/[0-9a-f-]{36}(\?tab=expected)?$/.test(f) || f === "/clients" || f === "/inbox") return f;
  return clientId ? `/clients/${clientId}` : "/clients";
}
