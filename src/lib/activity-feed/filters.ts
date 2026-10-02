import { actionsFor, isActivityCategory, type ActivityCategory } from "./categories";

// Feature 08 AC-7, AC-10 — Activity filters live in the URL: IDs, a category and dates only (never search text).
// Pure, so the parsing and the feed arguments are unit-tested.

export type ActivityFilters = {
  staff: string | null;
  client: string | null;
  document: string | null;
  action: ActivityCategory | null;
  from: string | null; // YYYY-MM-DD, IST, inclusive
  to: string | null;
};

export const NO_FILTERS: ActivityFilters = { staff: null, client: null, document: null, action: null, from: null, to: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
const uuidOrNull = (v: string | null) => (v && UUID.test(v) ? v.toLowerCase() : null);
const dateOrNull = (v: string | null) => (v && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

/** Unknown or malformed values are dropped (a hand-edited URL never errors). */
export function parseActivityParams(sp: Record<string, string | string[] | undefined>): ActivityFilters {
  const action = one(sp.action);
  return {
    staff: uuidOrNull(one(sp.staff)),
    client: uuidOrNull(one(sp.client)),
    document: uuidOrNull(one(sp.document)),
    action: isActivityCategory(action) ? action : null,
    from: dateOrNull(one(sp.from)),
    to: dateOrNull(one(sp.to)),
  };
}

export function activityQuery(f: ActivityFilters): string {
  const q = new URLSearchParams();
  for (const k of ["staff", "client", "document", "action", "from", "to"] as const) if (f[k]) q.set(k, f[k]!);
  return q.toString();
}

export const isFiltered = (f: ActivityFilters) => Object.values(f).some((v) => v !== null);

export type FeedCursor = { at: string; id: number };

/** The activity_feed argument for these filters (+ an optional cursor). Sign-ins only via the Sign-ins category. */
export function feedArgs(f: ActivityFilters, before?: FeedCursor | null): Record<string, unknown> {
  return {
    ...(f.staff ? { staff_id: f.staff } : {}),
    ...(f.client ? { client_id: f.client } : {}),
    ...(f.document ? { document_id: f.document } : {}),
    ...(f.action ? { actions: actionsFor(f.action) } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...(before ? { before } : {}),
  };
}
