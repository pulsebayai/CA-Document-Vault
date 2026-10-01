import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { todayInIndia } from "./schedule";
import {
  EXPECTED_SELECT, matchesStatus, officeToday, openCount, repeatedKinds, sortItems, toItem,
  type ExpectedItem, type RawExpected, type StatusFilter,
} from "./shape";

// Feature 04 step 4 — reads for the Expected tab, the Documents cards and Settings › Collection. Everything runs as
// the signed-in user (RLS on expected_doc follows the client: Limited users see only clients they can see).
// Errors are logged as a code + request ID only (no client data).


function fail(op: string, code: string | undefined): never {
  const requestId = randomUUID();
  console.error(`expected.${op}_failed`, { code: code ?? "unknown", requestId });
  throw new Error(`EXPECTED_${op.toUpperCase()}_FAILED`);
}

/** Today by 04's rule for the signed-in user's office. */
export async function todayForOffice(officeId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.from("office").select("is_test, test_today").eq("id", officeId).maybeSingle();
  return officeToday(data as { is_test: boolean; test_today: string | null } | null, todayInIndia());
}

export type ClientExpected = { today: string; items: ExpectedItem[]; open: number };

/**
 * Client › Expected (AC-13): items of one client, optionally one FY and group, filtered by status, sorted
 * group → type → newest period. `open` (the tab count) is Due + Overdue across the FY, whatever the status filter.
 */
export async function listClientExpected(
  officeId: string, clientId: string, opts: { fyId?: string | null; groupId?: string | null; status?: StatusFilter } = {},
): Promise<ClientExpected> {
  const supabase = await createClient();
  const [today, res, regs] = await Promise.all([
    todayForOffice(officeId),
    supabase.from("expected_doc").select(EXPECTED_SELECT).eq("client_id", clientId),
    supabase.from("client_registration").select("kind, active").eq("client_id", clientId),
  ]);
  if (res.error) fail("list", res.error.code);
  const repeated = repeatedKinds((regs.data ?? []) as Array<{ kind: string; active: boolean }>);
  const rows = ((res.data ?? []) as unknown as RawExpected[])
    .filter((r) => !opts.fyId || r.period.financial_year_id === opts.fyId);
  const all = rows.map((r) => toItem(r, today, repeated));
  const shown = sortItems(rows, all.filter((i) => (!opts.groupId || i.groupId === opts.groupId) && matchesStatus(i, opts.status ?? "open")));
  return { today, items: shown, open: openCount(all) };
}

/** Client › Documents cards (AC-14): the open items (Overdue first, then Due) per group. */
export async function openItemsByGroup(officeId: string, clientId: string): Promise<Map<string, ExpectedItem[]>> {
  const { items } = await listClientExpected(officeId, clientId, { status: "open" });
  const rank = { overdue: 0, due_today: 1, due: 2 } as Record<string, number>;
  const byGroup = new Map<string, ExpectedItem[]>();
  for (const i of items.filter((x) => x.open).sort((a, b) => (rank[a.state.kind] ?? 9) - (rank[b.state.kind] ?? 9))) {
    byGroup.set(i.groupId, [...(byGroup.get(i.groupId) ?? []), i]);
  }
  return byGroup;
}

export type CollectionMetric = {
  due: number; on_time: number; late: number; missing: number; on_time_pct: number | null; overdue_now: number;
  last_generated_at: string | null;
  groups: Array<{ doc_group_id: string; name: string; due: number; on_time: number; late: number; missing: number }>;
};

/** Settings › Collection (AC-16): metric 1 for [from, to]; Admin/Manager only (the function checks the role). */
export async function collectionMetricAs(from: string, to: string): Promise<CollectionMetric> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("collection_metric", { p_from: from, p_to: to });
  if (error) fail("metric", error.code);
  return data as CollectionMetric;
}
