import { z } from "zod";
import type { ClientType } from "./identifiers";
import { CLIENT_TYPES } from "./client";

// Spec 02 AC-7: the list's search state is sent in a POST body (server action), never in the URL.

export const PAGE_SIZE = 50;

export type ClientSearch = {
  query: string;
  clientType: ClientType | null;
  inchargeId: string | null;
  includeArchived: boolean;
  page: number;
  /** 12 (AC-27): only "my" clients (incharge, or assigned staff of an active group / plan type). Never changes access. */
  mine?: boolean;
};

/** Lenient: anything malformed falls back to "no filter" rather than an error the user can't act on. */
export function parseClientSearch(input: {
  query?: unknown; clientType?: unknown; inchargeId?: unknown; includeArchived?: unknown; page?: unknown; mine?: unknown;
}): ClientSearch {
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 100) : "";
  const clientType = (CLIENT_TYPES as readonly string[]).includes(input.clientType as string) ? (input.clientType as ClientType) : null;
  const inchargeId = z.uuid().safeParse(input.inchargeId).success ? (input.inchargeId as string) : null;
  const includeArchived = input.includeArchived === true;
  const page = typeof input.page === "number" && Number.isInteger(input.page) ? Math.min(Math.max(input.page, 1), 1000) : 1;
  return { query, clientType, inchargeId, includeArchived, page, ...(input.mine === true ? { mine: true } : {}) };
}

export const isFiltered = (s: ClientSearch) => !!(s.query || s.clientType || s.inchargeId || s.includeArchived || s.mine);

/**
 * 12 (AC-27): "My clients" from the URL flag (`?mine=1` / `?mine=0`). Absent = the role's default: on for Staff,
 * off for Admin/Manager. Limited never gets it (they see only their clients already).
 */
export function mineFromUrl(flag: string | string[] | undefined, role: string): { shown: boolean; on: boolean } {
  if (role === "limited") return { shown: false, on: false };
  const v = Array.isArray(flag) ? flag[0] : flag;
  return { shown: true, on: v === "1" ? true : v === "0" ? false : role === "staff" };
}
