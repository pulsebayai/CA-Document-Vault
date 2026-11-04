import { viewClients } from "@/lib/platform/queries";
import { NoAccess } from "../../../ui";
import { ClientsBrowser } from "./clients-browser";

export const dynamic = "force-dynamic";

/** 19 (spec Y5, AC-9): the firm's clients, read-only, PII in full (Y5a). Opening it is logged (audit + firm activity). */
export default async function PlatformClientsPage({ params }: PageProps<"/platform/firms/[id]/clients">) {
  const { id } = await params;
  const first = await viewClients(id, null, 1);
  if (!first.ok) return <NoAccess firmId={id} />;
  return <ClientsBrowser firmId={id} initial={first.data} />;
}
