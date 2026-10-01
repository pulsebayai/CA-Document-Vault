import { z } from "zod";
import { CHANNELS, RECEIVED_AS, type Channel, type ReceivedAs } from "./document";

// Spec 03b AC-3, AC-6, AC-8, AC-11.
// Filters are IDs, enums and dates only, so they may sit in the URL (Back, refresh and shared links work).
// The search text is never read from or written to the URL: it travels in server-action POST bodies and, between
// the header and /documents, in the tab's session storage. The text rules mirror search_documents.

export const PAGE_SIZE = 50;
export const MAX_WORDS = 5;
export const MAX_WORD_LENGTH = 50;
export const MAX_PAGE = 1000;
/** Header dropdown (AC-2): suggestions start at 2 characters; up to 5 clients and 5 documents. */
export const MIN_SUGGEST_CHARS = 2;
export const SUGGEST_LIMIT = 5;
export const SUGGEST_DEBOUNCE_MS = 250;
/**
 * AC-4: the header hands the search text to /documents in this tab's session storage — never the URL.
 * Session storage is per tab and cleared when the tab closes; nothing is sent to the server.
 */
export const SEARCH_TEXT_KEY = "cdv:documents-search-text";

export const SORTS = [
  { value: "received", label: "Date received (newest)" },
  { value: "added", label: "Date added (newest)" },
  { value: "docid", label: "DOC-ID (newest)" },
] as const;
export type Sort = (typeof SORTS)[number]["value"];

export const DOC_STATES = [
  { value: "classified", label: "Classified" },
  { value: "inbox", label: "Inbox" },
] as const;
export type DocState = (typeof DOC_STATES)[number]["value"];

// 07: the review status. "received" keeps 03b's raw meaning in the database (it also matches Inbox documents);
// the results page shows it as "To review" and pairs it with filed documents.
export const DOC_STATUSES = [
  { value: "received", label: "To review" },
  { value: "reviewed", label: "Reviewed" },
  { value: "needs_correction", label: "Needs correction" },
] as const;export type DocStatus = (typeof DOC_STATUSES)[number]["value"];

/** 07 AC-14: originals waiting to go back, or already sent (search_documents' `return` filter). */
export const DOC_RETURNS = [
  { value: "ready", label: "Ready to dispatch" },
  { value: "dispatched", label: "Dispatched" },
] as const;
export type DocReturn = (typeof DOC_RETURNS)[number]["value"];

export type DocumentFilters = {
  client: string | null;
  group: string | null;
  type: string | null;
  fy: string | null;
  period: string | null;
  registration: string | null;
  as: ReceivedAs | null;
  channel: Channel | null;
  by: string | null;
  from: string | null;
  to: string | null;
  status: DocStatus | null;
  state: DocState | null;
  /** 07: optional, so filters written before 07 (and their tests) keep their exact shape. */
  return?: DocReturn;
  archived: boolean;
  sort: Sort;
  page: number;
};

export const DEFAULT_FILTERS: DocumentFilters = Object.freeze({
  client: null, group: null, type: null, fy: null, period: null, registration: null, as: null, channel: null,
  by: null, from: null, to: null, status: null, state: null, archived: false, sort: "received", page: 1,
}) as DocumentFilters;

/** URL keys in the order they are written. */
const UUID_KEYS = ["client", "group", "type", "fy", "period", "registration"] as const;
const URL_ORDER = ["client", "group", "type", "fy", "period", "registration", "as", "channel", "by", "from", "to", "status", "state", "return", "archived", "sort", "page"] as const;

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const oneOf = <T extends string>(list: readonly { value: T }[], v: unknown): T | null =>
  list.some((x) => x.value === v) ? (v as T) : null;
const uuidOrNull = (v: unknown) => (z.uuid().safeParse(v).success ? (v as string) : null);

/** A real calendar date written YYYY-MM-DD (2026-02-30 is rejected). */
function dateOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** Lenient: a malformed value is dropped rather than failing, so a bad shared link still opens the page. */
export function parseDocumentSearchParams(params: Params): DocumentFilters {
  const get = (k: string) => first(params[k]);
  const f: DocumentFilters = { ...DEFAULT_FILTERS };
  for (const k of UUID_KEYS) f[k] = uuidOrNull(get(k));
  f.by = uuidOrNull(get("by"));
  f.as = oneOf(RECEIVED_AS, get("as"));
  f.channel = oneOf(CHANNELS, get("channel"));
  f.status = oneOf(DOC_STATUSES, get("status"));
  f.state = oneOf(DOC_STATES, get("state"));
  const ret = oneOf(DOC_RETURNS, get("return"));
  if (ret) f.return = ret;
  f.sort = oneOf(SORTS, get("sort")) ?? "received";
  f.archived = get("archived") === "1";
  const page = get("page");
  f.page = page && /^\d+$/.test(page) ? Math.min(Math.max(Number(page), 1), MAX_PAGE) : 1;
  f.from = dateOrNull(get("from"));
  f.to = dateOrNull(get("to"));
  if (f.from && f.to && f.from > f.to) [f.from, f.to] = [f.to, f.from];
  if (!f.client) f.registration = null; // GSTIN/TAN is offered only once a client is chosen
  return f;
}

/** The query string for these filters: non-default values only, fixed key order, never any text. */
export function filtersToQuery(f: DocumentFilters): string {
  const q = new URLSearchParams();
  for (const k of URL_ORDER) {
    const v = f[k];
    if (k === "archived") { if (v === true) q.set(k, "1"); continue; }
    if (k === "sort") { if (v !== DEFAULT_FILTERS.sort) q.set(k, String(v)); continue; }
    if (k === "page") { if (typeof v === "number" && v > 1) q.set(k, String(v)); continue; }
    if (typeof v === "string" && v) q.set(k, v);
  }
  return q.toString();
}

/** Trim, collapse whitespace, keep the first 5 words, each cut to 50 characters (as search_documents does). */
export function normaliseSearchText(text: string | null | undefined): string {
  if (!text) return "";
  return text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS).map((w) => w.slice(0, MAX_WORD_LENGTH)).join(" ");
}

/** A complete DOC-ID (any case, surrounding spaces ignored) → its canonical upper-case form; otherwise null. */
export function parseDocId(text: string | null | undefined): string | null {
  const t = (text ?? "").trim().toUpperCase();
  return /^DOC-FY\d{2}-\d{2}-\d{5,}$/.test(t) ? t : null;
}

export type SearchInput = {
  text?: string;
  filters: Record<string, string>;
  include_archived: boolean;
  sort: Sort;
  page: number;
  page_size?: number;
};

const RPC_KEYS: Record<Exclude<(typeof URL_ORDER)[number], "archived" | "sort" | "page">, string> = {
  client: "client_id", group: "group_id", type: "doc_type_id", fy: "fy_id", period: "period_id",
  registration: "registration_id", as: "received_as", channel: "channel", by: "received_by",
  from: "from", to: "to", status: "status", state: "state", return: "return",
};

/** The `p` argument for search_documents / search_document_facets. */
export function toSearchInput(f: DocumentFilters, text: string | null | undefined): SearchInput {
  const filters: Record<string, string> = {};
  for (const [k, rpcKey] of Object.entries(RPC_KEYS) as [keyof typeof RPC_KEYS, string][]) {
    const v = f[k];
    if (typeof v === "string" && v) filters[rpcKey] = v;
  }
  const t = normaliseSearchText(text);
  return { ...(t ? { text: t } : {}), filters, include_archived: f.archived, sort: f.sort, page: f.page };
}

/** True when any filter narrows the results (sort and page don't count). */
export function isFiltered(f: DocumentFilters): boolean {
  return f.archived || (Object.keys(RPC_KEYS) as (keyof typeof RPC_KEYS)[]).some((k) => f[k] != null);
}
