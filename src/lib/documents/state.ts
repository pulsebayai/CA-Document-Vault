import { daysBetween, shortDate } from "@/lib/expected/schedule";

// Spec 07 "Shown state": derived, never stored; the first match wins. Shared with 06 (Today), so 06 imports this
// file rather than repeating the order. The SQL side (search_documents' `return_state`, the "to review" and
// "ready to dispatch" counts) must select the same rows; tests/rls/review-dispatch.test.ts checks the two agree.
//   1 Archived · 2 In inbox · 3 Dispatched <date> · <method> · 4 Ready to dispatch · 5 Needs correction · <reason>
//   6 Document in office (13) · 7 Reviewed <date> by <name> · 8 To review
// 13: Ready to dispatch is a stored custody step (document.custody), not derived from the review. The SQL mirror is
// private.custody_state (search's `return_state`); tests/rls/custody.test.ts checks the two agree.

export const REVIEW_STATUSES = ["received", "reviewed", "needs_correction"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const DISPATCH_METHODS = [
  { value: "courier", label: "Courier" },
  { value: "hand_delivery", label: "Hand delivery" },
  { value: "client_collected", label: "Client collected" },
  { value: "other", label: "Other" },
] as const;
export type DispatchMethod = (typeof DISPATCH_METHODS)[number]["value"];

export const methodLabel = (m: DispatchMethod | string) => DISPATCH_METHODS.find((x) => x.value === m)?.label ?? m;

export type DocumentStateInput = {
  archived: boolean;
  clientId: string | null;
  docTypeId: string | null;
  receivedAs: "soft_copy" | "hard_copy" | "original" | string;
  status: ReviewStatus | string;
  reviewedAt?: string | null; // timestamptz
  reviewedByName?: string | null;
  correctionReason?: string | null;
  dispatchedOn?: string | null; // date of the live packet, if any
  dispatchMethod?: DispatchMethod | string | null;
  /** 12: the client wants this hard copy back. Legacy rows/inputs with receivedAs "original" count as returnable. */
  returnable?: boolean | null;
  /** 12: Needs correction kind (wrong file | wrong details), when given. */
  correctionKind?: "file" | "details" | string | null;
  /** 13: the stored custody step (null = not placed in office). */
  custody?: CustodyStep | null;
  /** 13: when it was marked in office (timestamptz). */
  inOfficeAt?: string | null;
};

export type CustodyStep = "in_office" | "ready";
/** 13 (spec AC-10, Sankar #14): a returnable document in office for more than this many days is flagged. */
export const HELD_AFTER_DAYS = 30;

/** 12 (spec AC-11): what 07 called an "original" is now a returnable hard copy; "original" is legacy input only. */
export const isReturnable = (d: Pick<DocumentStateInput, "receivedAs" | "returnable">) =>
  d.returnable === true || d.receivedAs === "original";

/** 12: the paper badge on a document row — "Returnable" (bad) for a returnable hard copy, "Hard copy" (warn) otherwise. */
export const paperBadge = (d: Pick<DocumentStateInput, "receivedAs" | "returnable">): { label: string; tone: "bad" | "warn" } | null =>
  isReturnable(d) ? { label: "Returnable", tone: "bad" } : d.receivedAs === "hard_copy" ? { label: "Hard copy", tone: "warn" } : null;

export type ShownState =
  | { kind: "archived"; text: string }
  | { kind: "inbox"; text: string }
  | { kind: "dispatched"; text: string; on: string; method: string }
  | { kind: "ready"; text: string }
  | { kind: "needs_correction"; text: string; reason: string }
  | { kind: "in_office"; text: string }
  | { kind: "reviewed"; text: string; at: string | null; by: string | null }
  | { kind: "to_review"; text: string };
export type ShownStateKind = ShownState["kind"];

/** Filed = client + type (03): only filed documents are reviewable. */
export const isFiled = (d: Pick<DocumentStateInput, "clientId" | "docTypeId">) => d.clientId !== null && d.docTypeId !== null;

/** "To review": filed, live, status received. Same rule as Today's count (06). */
export const isToReview = (d: DocumentStateInput) => !d.archived && isFiled(d) && d.status === "received";

const hasDecision = (d: Pick<DocumentStateInput, "status">) => d.status === "reviewed" || d.status === "needs_correction";
const isHardCopy = (d: Pick<DocumentStateInput, "receivedAs">) => d.receivedAs === "hard_copy" || d.receivedAs === "original";

/**
 * "Ready to dispatch": a filed, live returnable copy marked Ready (13: stored), reviewed or Needs correction, not in a
 * live packet (SQL `return_state = 'ready'`).
 */
export const isReadyToDispatch = (d: DocumentStateInput) =>
  !d.archived && isFiled(d) && isReturnable(d) && !d.dispatchedOn && d.custody === "ready" && hasDecision(d);

/** 13 (spec AC-11): a filed, live hard copy with a review decision and no custody step yet ("To place in office"). */
export const isToPlace = (d: DocumentStateInput) =>
  !d.archived && isFiled(d) && isHardCopy(d) && !d.custody && !d.dispatchedOn && hasDecision(d);

/** 13 (spec AC-9): the next custody click: Mark in office, then Ready to dispatch (returnable only); otherwise none. */
export function custodyAction(d: DocumentStateInput): "in_office" | "ready" | null {
  if (isToPlace(d)) return "in_office";
  if (!d.archived && isFiled(d) && d.custody === "in_office" && isReturnable(d) && hasDecision(d) && !d.dispatchedOn) return "ready";
  return null;
}

const istDay = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(at));

/** The one state a document shows (spec order). `today` = India date, for short dates. */
export function documentState(d: DocumentStateInput, today: string): ShownState {
  if (d.archived) return { kind: "archived", text: "Archived" };
  if (!isFiled(d)) return { kind: "inbox", text: "Untagged" }; // 12 (D2)
  if (isReturnable(d) && d.dispatchedOn) {
    const method = methodLabel(d.dispatchMethod ?? "other");
    return { kind: "dispatched", text: `Dispatched ${shortDate(d.dispatchedOn, today)} · ${method}`, on: d.dispatchedOn, method };
  }
  if (isReadyToDispatch(d)) return { kind: "ready", text: "Ready to dispatch" };
  if (d.status === "needs_correction") {
    const reason = d.correctionReason ?? "";
    const kind = d.correctionKind === "file" ? "wrong file" : d.correctionKind === "details" ? "wrong details" : null; // 12 (AC-21)
    return { kind: "needs_correction", text: ["Needs correction", kind, reason || null].filter(Boolean).join(" · "), reason };
  }
  if (d.status === "reviewed" && d.custody && isHardCopy(d)) return { kind: "in_office", text: "Document in office" }; // 13
  if (d.status === "reviewed") {
    const at = d.reviewedAt ? shortDate(istDay(d.reviewedAt), today) : null;
    const by = d.reviewedByName ?? null;
    return { kind: "reviewed", text: ["Reviewed", at, by ? `by ${by}` : null].filter(Boolean).join(" "), at, by };
  }
  return { kind: "to_review", text: "To review" };
}

/** AC-11: originals not yet dispatched show "Held N days" (today − received on, India dates); otherwise null. */
export function heldDays(d: DocumentStateInput & { receivedOn: string }, today: string): number | null {
  if (d.archived || !isReturnable(d) || d.dispatchedOn) return null;
  return Math.max(daysBetween(d.receivedOn, today), 0);
}

/** 13 (spec AC-10): office days since it was marked in office, for a returnable copy in custody not yet dispatched. */
export function inOfficeDays(d: DocumentStateInput, today: string): number | null {
  if (d.archived || !isReturnable(d) || !d.custody || d.dispatchedOn || !d.inOfficeAt) return null;
  return Math.max(daysBetween(istDay(d.inOfficeAt), today), 0);
}

/** 13: "In office > 30 days" (Sankar #14). */
export const isHeld = (d: DocumentStateInput, today: string) => (inOfficeDays(d, today) ?? 0) > HELD_AFTER_DAYS;

/** Which row action a user gets next (AC-12). Undo actions live on the document page only. */
export function nextAction(state: ShownState): "review" | "dispatch" | null {
  if (state.kind === "to_review" || state.kind === "needs_correction") return "review";
  if (state.kind === "ready") return "dispatch";
  return null;
}
