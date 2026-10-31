import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { istDate } from "@/lib/documents/period";
import { clientOption, listPeriods, typesForClient } from "@/lib/documents/queries";
import { PageHeader } from "@/components/ui";
import { ReceiptForm } from "./receipt-form";

/**
 * Log receipt (feature 13, spec AC-13 … AC-16): the reception desk logs paper that came in — client, what, how many,
 * who handed it over — without opening Add document per paper. Every staff role (Limited: their clients).
 * ?client=<uuid> pre-fills the client (UUID only in the URL; no PII).
 */
export default async function LogReceiptPage({ searchParams }: PageProps<"/documents/receipt">) {
  await requireStaff();
  const sp = await searchParams;
  const clientParam = typeof sp.client === "string" && z.uuid().safeParse(sp.client).success ? sp.client : null;
  const client = clientParam ? await clientOption(clientParam) : null;
  const [types, periods] = await Promise.all([client ? typesForClient(client.id) : Promise.resolve({ planTypes: [], otherTypes: [], registrations: [] }), listPeriods()]);
  return (
    <div className="mx-auto max-w-[815px]">
      <PageHeader title="Log receipt" subtitle="Paper that came in at the desk. Each paper gets a DOC-ID to write on it; attach the scan later." />
      <ReceiptForm initialClient={client} initialTypes={types} periods={periods} today={istDate()} />
    </div>
  );
}
