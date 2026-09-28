import { requireStaff } from "@/lib/auth/staff";
import { listStaffOptions, searchClientsAs } from "@/lib/clients/queries";
import { parseClientSearch } from "@/lib/validation/client-search";
import { ClientsBrowser } from "./clients-browser";

/**
 * Mockup 03-clients.jpg (spec AC-7). First page is rendered on the server with no filters; searching
 * happens through a server action, so nothing typed ever reaches the URL. "Has overdue" arrives with 04,
 * Export with 08.
 */
export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const me = await requireStaff();
  const sp = await searchParams;
  // After Add document from the header (spec 03 AC-4). Only a well-formed DOC-ID is echoed.
  const saved = typeof sp.saved === "string" && /^DOC-FY\d{2}-\d{2}-\d{5,}$/.test(sp.saved) ? sp.saved : null;
  const [initial, staff] = await Promise.all([searchClientsAs(parseClientSearch({})), listStaffOptions()]);
  return (
    <>
      {saved && <p role="status" className="mb-4 rounded-lg bg-ok-soft px-4 py-3 text-[13.5px] text-ok"><strong className="font-semibold">{saved}</strong> saved.</p>}
      <ClientsBrowser initial={initial} staff={staff} canAdd={me.role !== "limited"} />
    </>
  );
}
