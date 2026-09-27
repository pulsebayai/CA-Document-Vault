"use server";

import { requireStaff } from "@/lib/auth/staff";
import { parseClientSearch } from "@/lib/validation/client-search";
import { searchClientsAs, type ClientSearchResult } from "./queries";

export type SearchResult = ({ ok: true } & ClientSearchResult) | { ok: false; error: string };

/**
 * Spec AC-7: search runs as a server action (POST), so search text and filters never appear in the URL,
 * browser history or access logs.
 */
export async function searchClients(input: {
  query?: string; clientType?: string | null; inchargeId?: string | null; includeArchived?: boolean; page?: number;
}): Promise<SearchResult> {
  await requireStaff();
  try {
    return { ok: true, ...(await searchClientsAs(parseClientSearch(input ?? {}))) };
  } catch {
    return { ok: false, error: "Could not load clients. Please try again." };
  }
}
