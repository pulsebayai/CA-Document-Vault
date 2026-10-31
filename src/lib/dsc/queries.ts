import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { todayForOffice } from "@/lib/expected/queries";
import { DEFAULT_REMIND_DAYS, type CustodyMove } from "./expiry";

// Feature 14 — reads for the DSC tab (spec AC-1, AC-3, AC-9), Client › Settings (AC-10) and Today (AC-11). All run as
// the signed-in user (RLS: the client must be visible). The password column is never selected: it isn't in the
// column grant, so a "*" select would fail — every select here lists its columns.

export type DscRecord = {
  id: string; holderName: string; dscClass: string | null; issuer: string | null; tokenNote: string | null;
  expiresOn: string; passwordSetAt: string; archivedAt: string | null; archiveReason: string | null;
  custody: Array<CustodyMove & { note: string | null; actor: string | null; at: string }>;
};
export type ClientDscs = { today: string; remindDays: number; live: DscRecord[]; archived: DscRecord[] };

export const DSC_COLUMNS = "id, holder_name, dsc_class, issuer, token_note, expires_on, password_set_at, archived_at, archive_reason";

function fail(op: string, code: string | undefined): never {
  console.error(`dsc.${op}_failed`, { code: code ?? "unknown", requestId: randomUUID() });
  throw new Error(`DSC_${op.toUpperCase()}_FAILED`);
}

type Row = {
  id: string; holder_name: string; dsc_class: string | null; issuer: string | null; token_note: string | null;
  expires_on: string; password_set_at: string; archived_at: string | null; archive_reason: string | null;
  dsc_custody: Array<{ direction: "out" | "in"; person_name: string; on_date: string; note: string | null; at: string;
    actor: { full_name: string } | null }>;
};

/** Soonest expiry first; custody newest first (AC-3, AC-9). */
export async function clientDscs(clientId: string, officeId: string): Promise<ClientDscs> {
  const supabase = await createClient();
  const [today, list, setting] = await Promise.all([
    todayForOffice(officeId),
    supabase.from("dsc")
      .select(`${DSC_COLUMNS}, dsc_custody (direction, person_name, on_date, note, at, actor:actor_id (full_name))`)
      .eq("client_id", clientId)
      .order("expires_on", { ascending: true })
      .order("holder_name", { ascending: true }),
    supabase.from("client_dsc_setting").select("remind_days").eq("client_id", clientId).maybeSingle(),
  ]);
  if (list.error) fail("list", list.error.code);
  if (setting.error) fail("setting", setting.error.code); // review N-3: never show the default in place of a saved value
  const records = ((list.data ?? []) as unknown as Row[]).map((r): DscRecord => ({
    id: r.id, holderName: r.holder_name, dscClass: r.dsc_class, issuer: r.issuer, tokenNote: r.token_note,
    expiresOn: r.expires_on, passwordSetAt: r.password_set_at, archivedAt: r.archived_at, archiveReason: r.archive_reason,
    custody: [...(r.dsc_custody ?? [])].sort((a, b) => b.at.localeCompare(a.at)).map((c) => ({
      direction: c.direction, person_name: c.person_name, on_date: c.on_date, note: c.note, at: c.at, actor: c.actor?.full_name ?? null,
    })),
  }));
  return {
    today,
    remindDays: (setting.data?.remind_days as number | undefined) ?? DEFAULT_REMIND_DAYS,
    live: records.filter((r) => !r.archivedAt),
    archived: records.filter((r) => r.archivedAt),
  };
}

/** Live DSCs for the tab label ("DSC N", AC-1). null when it can't be read: the other tabs must still load (review N-2). */
export async function liveDscCount(clientId: string): Promise<number | null> {
  const supabase = await createClient();
  const { count, error } = await supabase.from("dsc").select("id", { count: "exact", head: true })
    .eq("client_id", clientId).is("archived_at", null);
  if (error) {
    console.error("dsc.count_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    return null;
  }
  return count ?? 0;
}

export async function remindDaysFor(clientId: string): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_dsc_setting").select("remind_days").eq("client_id", clientId).maybeSingle();
  if (error) fail("setting", error.code);
  return (data?.remind_days as number | undefined) ?? DEFAULT_REMIND_DAYS;
}

export type DueDsc = {
  id: string; clientId: string; clientCode: string; clientName: string; holderName: string; dscClass: string | null;
  expiresOn: string; daysLeft: number; remindDays: number; outTo: string | null; outSince: string | null;
};

/** Today's "DSC expiring" (AC-11): its own call, today_items untouched (T2). A failure hides the card, never Today (N-2). */
export async function dscDue(scope: "mine" | "everyone"): Promise<{ count: number; rows: DueDsc[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dsc_due", { p_scope: scope });
  if (error) {
    console.error("dsc.due_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    return { count: 0, rows: [] };
  }
  const r = data as { count: number; rows: Array<Record<string, unknown>> };
  return {
    count: r.count,
    rows: r.rows.map((x) => ({
      id: x.id as string, clientId: x.client_id as string, clientCode: x.client_code as string, clientName: x.client_name as string,
      holderName: x.holder_name as string, dscClass: (x.dsc_class as string | null) ?? null, expiresOn: x.expires_on as string,
      daysLeft: x.days_left as number, remindDays: x.remind_days as number,
      outTo: (x.out_to as string | null) ?? null, outSince: (x.out_since as string | null) ?? null,
    })),
  };
}
