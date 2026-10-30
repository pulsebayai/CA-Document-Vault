// Feature 07: database rule codes → plain messages (never the DB text: it can echo values). Shared by the review
// and dispatch actions. Pure, so the mapping is unit-tested.

const MESSAGES: Array<[RegExp, string]> = [
  [/ALREADY_REVIEWED/, "Already reviewed. The page has been refreshed."],
  [/NOT_REVIEWED/, "This document is already back to To review."],
  [/NOT_CLASSIFIED/, "File the document (client and type) before reviewing it."],
  [/REASON_REQUIRED/, "Give a reason (up to 500 characters)."],
  [/ROLE_REQUIRED: sign in/, "Your session has ended. Sign in again."],
  // 12 (AC-24): Staff can undo a review now; a refused undo is a dispatch undo (Admin/Manager) or a Limited user.
  [/ROLE_REQUIRED: only Admin, Manager or Staff/, "Your role can't undo a review."],
  [/ROLE_REQUIRED/, "Only an Admin or Manager can undo this."],
  [/RECIPIENT_REQUIRED/, "Enter who received it (up to 120 characters)."],
  [/DATE_REQUIRED/, "Enter the date dispatched."],
  [/DATE_FUTURE/, "The dispatch date can't be in the future."],
  [/DATE_BEFORE_RECEIVED/, "The dispatch date can't be before a ticked original was received."],
  [/METHOD_REQUIRED|invalid input value for enum/, "Choose how it was dispatched."],
  [/NOT_ELIGIBLE|ALREADY_DISPATCHED|dispatch_item_live_key/, "Some originals are no longer ready to dispatch. The list has been refreshed — check the ticks and save again."],
  [/NO_DOCUMENTS/, "Tick at least one original."],
  [/NOT_DISPATCHED/, "This original is no longer in a packet. The page has been refreshed."],
  [/RECEIVED_ON_FUTURE/, "Received on can't be in the future."],
  [/ARCHIVED/, "Unarchive the document before changing it."],
  [/NOT_FOUND/, "Not found — it may have been moved or you may no longer have access."],
];

export function reviewErrorMessage(message: string | undefined): string {
  return MESSAGES.find(([re]) => re.test(message ?? ""))?.[1] ?? "Couldn't save. Please try again.";
}

/** A refusal that means "someone else changed it first": the UI refreshes instead of only showing the error. */
export const isStale = (message: string | undefined) =>
  /ALREADY_REVIEWED|NOT_REVIEWED|NOT_ELIGIBLE|ALREADY_DISPATCHED|NOT_DISPATCHED|dispatch_item_live_key/.test(message ?? "");
