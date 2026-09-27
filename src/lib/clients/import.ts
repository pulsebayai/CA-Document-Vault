import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { IMPORT_COLUMNS, type ImportContext } from "@/lib/csv/parse";

type Supabase = Awaited<ReturnType<typeof createClient>>;
const PAGE = 1000; // PostgREST's default max rows per request

/** Reads every row of a query page by page (ordered by id so pages are stable). */
async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) {
      console.error("clients.import_context_failed", { code: error.code });
      throw new Error("Could not check the file against existing clients.");
    }
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * What a CSV row is checked against (AC-15, AC-16), read as the signed-in user (RLS applies; import is Staff+,
 * who see every client). Read in pages with plain GETs — no PAN or name ever goes into a request URL.
 */
export async function loadImportContext(supabase: Supabase): Promise<ImportContext> {
  const [staff, groups, clients, regs] = await Promise.all([
    supabase.from("staff_user").select("id, email").eq("status", "active"),
    supabase.from("doc_group").select("id, name, enabled_for_new_clients").eq("active", true).order("sort"),
    all<{ id: string; code: string; name: string; pan: string | null }>((a, b) =>
      supabase.from("client").select("id, code, name, pan").is("archived_at", null).order("id").range(a, b)),
    all<{ id: string; number: string }>((a, b) =>
      supabase.from("client_registration").select("id, number").order("id").range(a, b)),
  ]);
  if (staff.error || groups.error) {
    console.error("clients.import_context_failed", { code: (staff.error ?? groups.error)?.code });
    throw new Error("Could not check the file against existing clients.");
  }
  return {
    staffByEmail: new Map((staff.data ?? []).map((s) => [String(s.email).toLowerCase(), s.id as string])),
    groupsByName: new Map((groups.data ?? []).map((g) => [String(g.name).toLowerCase(), g.id as string])),
    defaultGroupIds: (groups.data ?? []).filter((g) => g.enabled_for_new_clients).map((g) => g.id as string),
    existingPans: new Map(clients.filter((c) => c.pan).map((c) => [c.pan as string, c.code])),
    existingNames: new Set(clients.map((c) => c.name.toLowerCase())),
    existingRegistrations: new Set(regs.map((r) => r.number)),
  };
}

/** Rows as sent by the browser. Cell length is checked by the validator (500); this only caps the payload. */
export const rawRowsSchema = (max: number) => z.array(z.object({
  row: z.int().min(2).max(10_000),
  cells: z.object(Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, z.string().max(2000)])) as Record<(typeof IMPORT_COLUMNS)[number], z.ZodString>),
  problem: z.string().max(200).optional(),
})).min(1).max(max);
