"use client";

import { SearchView, type SearchScope } from "@/app/(app)/documents/(search)/search-view";
import { DocumentActivityRow } from "@/components/document-activity-row";
import { lastActivity } from "@/lib/activity-feed/actions";
import type { FilterOptions } from "@/lib/search/queries";
import type { DocumentFilters } from "@/lib/validation/document-search";

// Feature 15 (spec AC-1…AC-7) — Client › All documents: 03b's /documents table for this client only (U4), with Last
// activity and the expandable row. `filters` are already scoped (lib/search/scope.ts: this client, the current FY
// unless the URL chose one; null FY = All years). The scope carries the activity actions, so /documents' view
// imports nothing new.
const loadLast: SearchScope["loadLast"] = (ids) => lastActivity(ids);
const rowExtra: SearchScope["rowExtra"] = (d) => <DocumentActivityRow documentId={d.id} docCode={d.docCode} />;

export function AllDocumentsView({ clientId, filters, options, currentFyId }: {
  clientId: string; filters: DocumentFilters; options: FilterOptions; currentFyId: string | null;
}) {
  return <SearchView filters={filters} options={options} scope={{ clientId, currentFyId, loadLast, rowExtra }} />;
}
