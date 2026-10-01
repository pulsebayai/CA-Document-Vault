import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { toTodayCard, uploadHref, type Scope, type Show, type TodayCard, type TodayRaw } from "./shape";

// Feature 06 — Today data (AC-2…AC-5): one call to today_items() as the signed-in user (RLS applies).
// Errors are logged as a code + request ID only.

export class TodayError extends Error {
  constructor(readonly requestId: string) { super("TODAY_FAILED"); }
}

export type TodayData = {
  today: string; counts: { overdue: number; dueWeek: number; toReview: number; ready: number };
  /** Cards in scope and filter (all pages): "N clients need something". */
  clients: number; cards: TodayCard[]; hasMore: boolean;
};

export async function todayDataAs(scope: Scope, show: Show | null, page: number): Promise<TodayData> {
  const supabase = await createClient();
  // "Show more" (?page=N) shows pages 0…N, 30 cards each, so earlier cards stay on a reload.
  const pages = await Promise.all(Array.from({ length: page + 1 }, (_, p) =>
    supabase.rpc("today_items", { p_scope: scope, p_show: show, p_page: p })));
  const failed = pages.find((r) => r.error);
  if (failed?.error) {
    const requestId = randomUUID();
    console.error("today.load_failed", { code: failed.error.code ?? "unknown", requestId });
    throw new TodayError(requestId);
  }
  const raws = pages.map((r) => r.data as TodayRaw);
  const last = raws[raws.length - 1];
  const cards = raws.flatMap((r) => r.cards.map((c) => toTodayCard(c, last.today)));
  // Upload (Add document pre-filled, 04) needs the item's type / period / registration IDs: one lookup under RLS.
  const ids = cards.flatMap((c) => c.rows.map((r) => r.id));
  // Review I-2: in batches of 100 (a 30-card page can hold hundreds of rows; one GET would exceed URL limits).
  // A failed batch only loses that batch's Upload links, and is logged.
  type Ref = { id: string; doc_type_id: string; period_id: string; registration_id: string | null };
  const refs: Ref[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from("expected_doc").select("id, doc_type_id, period_id, registration_id").in("id", ids.slice(i, i + 100));
    if (error) console.error("today.upload_refs_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    refs.push(...((data ?? []) as Ref[]));
  }
  if (refs.length > 0) {
    const byId = new Map(refs.map((x) => [x.id, x]));
    for (const c of cards) for (const r of c.rows) {
      const x = byId.get(r.id);
      if (x) r.uploadHref = uploadHref(c.clientId, { typeId: x.doc_type_id, periodId: x.period_id, registrationId: x.registration_id });
    }
  }
  return {
    today: last.today,
    counts: { overdue: last.counts.overdue, dueWeek: last.counts.due_week, toReview: last.counts.to_review ?? 0, ready: last.counts.ready ?? 0 },
    clients: last.clients ?? cards.length, cards, hasMore: last.has_more,
  };
}
