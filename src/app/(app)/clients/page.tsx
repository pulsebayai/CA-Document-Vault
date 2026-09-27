import { requireStaff } from "@/lib/auth/staff";
import { listStaffOptions, searchClientsAs } from "@/lib/clients/queries";
import { parseClientSearch } from "@/lib/validation/client-search";
import { ClientsBrowser } from "./clients-browser";

/**
 * Mockup 03-clients.jpg (spec AC-7). First page is rendered on the server with no filters; searching
 * happens through a server action, so nothing typed ever reaches the URL. "Has overdue" arrives with 04,
 * Import CSV with step 10 (no dead links), Export with 08.
 */
export default async function ClientsPage() {
  const me = await requireStaff();
  const [initial, staff] = await Promise.all([searchClientsAs(parseClientSearch({})), listStaffOptions()]);
  return <ClientsBrowser initial={initial} staff={staff} canAdd={me.role !== "limited"} />;
}
