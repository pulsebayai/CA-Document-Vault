import { requireStaff } from "@/lib/auth/staff";
import { filterOptionsAs } from "@/lib/search/queries";
import { parseDocumentSearchParams } from "@/lib/validation/document-search";
import { SearchView } from "./search-view";

// Spec 03b AC-5…AC-11 — /documents, the search results page (not in the mockup; agreed deviation in ui-reference.md).
// Filters come from the URL (IDs, enums and dates only), so Back, refresh and shared links work. The search text is
// never in the URL: the view reads it from this tab's session storage and searches through server actions (POST).
export default async function DocumentsPage({ searchParams }: PageProps<"/documents">) {
  await requireStaff();
  const filters = parseDocumentSearchParams(await searchParams);
  const options = await filterOptionsAs(filters.client);
  return <SearchView filters={filters} options={options} />;
}
