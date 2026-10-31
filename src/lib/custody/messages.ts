// Feature 13 — custody refusals → plain messages (never the database text). Pure, so the mapping is unit-tested.

export type CustodySkipReason =
  | "NOT_FOUND" | "ARCHIVED" | "NOT_CLASSIFIED" | "SOFT_COPY" | "NOT_REVIEWED" | "NOT_RETURNABLE" | "NOT_IN_OFFICE" | "ALREADY";

/** Per-document reasons from set_custody (spec AC-9): shown in the single-document message and the bulk summary. */
export const SKIP_LABEL: Record<CustodySkipReason, string> = {
  NOT_FOUND: "not found or no access",
  ARCHIVED: "archived",
  NOT_CLASSIFIED: "untagged (no client or type)",
  SOFT_COPY: "soft copy",
  NOT_REVIEWED: "not reviewed yet",
  NOT_RETURNABLE: "not returnable (the firm keeps it)",
  NOT_IN_OFFICE: "not marked in office yet",
  ALREADY: "already done",
};

export const skipLabel = (reason: string) => SKIP_LABEL[reason as CustodySkipReason] ?? "couldn't be changed";

const MESSAGES: Array<[RegExp, string]> = [
  [/ROLE_REQUIRED/, "Your session has ended. Sign in again."],
  [/NOT_IN_CUSTODY/, "This document isn't marked in office. The page has been refreshed."],
  [/DISPATCHED/, "This document is in a dispatch packet. Undo the dispatch first."],
  [/ARCHIVED/, "Unarchive the document before changing it."],
  [/TOO_MANY/, "Up to 200 documents at a time."],
  [/NOT_FOUND/, "Not found — it may have been moved or you may no longer have access."],
];

export function custodyErrorMessage(message: string | undefined): string {
  return MESSAGES.find(([re]) => re.test(message ?? ""))?.[1] ?? "Couldn't save. Please try again.";
}

/** A refusal that means "someone else changed it first": the UI refreshes. */
export const isCustodyStale = (message: string | undefined) => /NOT_IN_CUSTODY|DISPATCHED/.test(message ?? "");

/** "Marked in office." / "2 marked in office · 1 skipped (not reviewed yet)." */
export function custodySummary(step: "in_office" | "ready", done: number, skipped: Array<{ reason: string }>): string {
  const what = step === "in_office" ? "marked in office" : "marked ready to dispatch";
  if (done === 1 && skipped.length === 0) return `${what[0].toUpperCase()}${what.slice(1)}.`;
  const reasons = [...new Set(skipped.map((s) => skipLabel(s.reason)))].join(", ");
  const head = `${done} ${what}`;
  return skipped.length ? `${head} · ${skipped.length} skipped (${reasons}).` : `${head}.`;
}
