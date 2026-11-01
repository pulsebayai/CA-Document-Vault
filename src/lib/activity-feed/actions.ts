"use server";

import { requireStaff } from "@/lib/auth/staff";
import { parseActivityParams } from "./filters";
import { EXPANDED_EVENTS } from "./last-activity";
import { documentEventsAs, lastActivityAs, loadFeed, type FeedResult, type LastActivity } from "./queries";

// Feature 08 AC-5 — "Load earlier": the next page for the same filters (re-parsed here; never trusted as given).
export async function loadEarlier(query: string, before: { at: string; id: number }): Promise<FeedResult> {
  await requireStaff();
  const at = typeof before?.at === "string" ? before.at : "";
  const id = Number(before?.id);
  if (!at || !Number.isSafeInteger(id) || Number.isNaN(Date.parse(at))) return { ok: false, error: "Invalid request." };
  const filters = parseActivityParams(Object.fromEntries(new URLSearchParams(typeof query === "string" ? query : "")));
  return loadFeed(filters, { at, id });
}

// ── Feature 15: the All documents tab (spec U2, U3) ──────────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LastActivityResult = { ok: true; rows: LastActivity[] } | { ok: false; error: string };

/** Last activity for one page of the table (≤ 50 IDs; one call per page, U2). */
export async function lastActivity(ids: unknown): Promise<LastActivityResult> {
  await requireStaff();
  if (!Array.isArray(ids) || ids.length > 50 || !ids.every((x) => typeof x === "string" && UUID.test(x))) return { ok: false, error: "Invalid request." };
  try {
    return { ok: true, rows: await lastActivityAs(ids as string[]) };
  } catch {
    return { ok: false, error: "Last activity could not be loaded." };
  }
}

/** An expanded row's newest events, fetched when the row opens (U3). */
export async function documentEvents(documentId: unknown): Promise<FeedResult> {
  await requireStaff();
  if (typeof documentId !== "string" || !UUID.test(documentId)) return { ok: false, error: "Invalid request." };
  return documentEventsAs(documentId, EXPANDED_EVENTS);
}
