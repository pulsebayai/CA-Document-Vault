import { daysBetween, shortDate } from "@/lib/expected/schedule";

// Spec 07 "Shown state": derived, never stored; the first match wins. Shared with 06 (Today), so 06 imports this
// file rather than repeating the order. The SQL side (search_documents' `return_state`, the "to review" and
// "ready to dispatch" counts) must select the same rows; tests/rls/review-dispatch.test.ts checks the two agree.
//   1 Archived · 2 In inbox · 3 Dispatched <date> · <method> · 4 Ready to dispatch · 5 Needs correction · <reason>
//   6 Reviewed <date> by <name> · 7 To review

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
};

export type ShownState =
  | { kind: "archived"; text: string }
  | { kind: "inbox"; text: string }
  | { kind: "dispatched"; text: string; on: string; method: string }
  | { kind: "ready"; text: string }
  | { kind: "needs_correction"; text: string; reason: string }
  | { kind: "reviewed"; text: string; at: string | null; by: string | null }
  | { kind: "to_review"; text: string };
export type ShownStateKind = ShownState["kind"];

/** Filed = client + type (03): only filed documents are reviewable. */
export const isFiled = (d: Pick<DocumentStateInput, "clientId" | "docTypeId">) => d.clientId !== null && d.docTypeId !== null;

/** "To review": filed, live, status received. Same rule as Today's count (06). */
export const isToReview = (d: DocumentStateInput) => !d.archived && isFiled(d) && d.status === "received";

/** "Ready to dispatch": a filed, live original, reviewed or Needs correction, not in a live packet (SQL `return_state = 'ready'`). */
export const isReadyToDispatch = (d: DocumentStateInput) =>
  !d.archived && isFiled(d) && d.receivedAs === "original" && !d.dispatchedOn
  && (d.status === "reviewed" || d.status === "needs_correction");

const istDay = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(at));

/** The one state a document shows (spec order). `today` = India date, for short dates. */
export function documentState(d: DocumentStateInput, today: string): ShownState {
  if (d.archived) return { kind: "archived", text: "Archived" };
  if (!isFiled(d)) return { kind: "inbox", text: "In inbox" };
  if (d.receivedAs === "original" && d.dispatchedOn) {
    const method = methodLabel(d.dispatchMethod ?? "other");
    return { kind: "dispatched", text: `Dispatched ${shortDate(d.dispatchedOn, today)} · ${method}`, on: d.dispatchedOn, method };
  }
  if (isReadyToDispatch(d)) return { kind: "ready", text: "Ready to dispatch" };
  if (d.status === "needs_correction") {
    const reason = d.correctionReason ?? "";
    return { kind: "needs_correction", text: reason ? `Needs correction · ${reason}` : "Needs correction", reason };
  }
  if (d.status === "reviewed") {
    const at = d.reviewedAt ? shortDate(istDay(d.reviewedAt), today) : null;
    const by = d.reviewedByName ?? null;
    return { kind: "reviewed", text: ["Reviewed", at, by ? `by ${by}` : null].filter(Boolean).join(" "), at, by };
  }
  return { kind: "to_review", text: "To review" };
}

/** AC-11: originals not yet dispatched show "Held N days" (today − received on, India dates); otherwise null. */
export function heldDays(d: DocumentStateInput & { receivedOn: string }, today: string): number | null {
  if (d.archived || d.receivedAs !== "original" || d.dispatchedOn) return null;
  return Math.max(daysBetween(d.receivedOn, today), 0);
}

/** Which row action a user gets next (AC-12). Undo actions live on the document page only. */
export function nextAction(state: ShownState): "review" | "dispatch" | null {
  if (state.kind === "to_review" || state.kind === "needs_correction") return "review";
  if (state.kind === "ready") return "dispatch";
  return null;
}
