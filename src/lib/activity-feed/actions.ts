"use server";

import { requireStaff } from "@/lib/auth/staff";
import { parseActivityParams } from "./filters";
import { loadFeed, type FeedResult } from "./queries";

// Feature 08 AC-5 — "Load earlier": the next page for the same filters (re-parsed here; never trusted as given).
export async function loadEarlier(query: string, before: { at: string; id: number }): Promise<FeedResult> {
  await requireStaff();
  const at = typeof before?.at === "string" ? before.at : "";
  const id = Number(before?.id);
  if (!at || !Number.isSafeInteger(id) || Number.isNaN(Date.parse(at))) return { ok: false, error: "Invalid request." };
  const filters = parseActivityParams(Object.fromEntries(new URLSearchParams(typeof query === "string" ? query : "")));
  return loadFeed(filters, { at, id });
}
