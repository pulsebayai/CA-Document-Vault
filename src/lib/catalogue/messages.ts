// Feature 05: type-governance rule codes → plain messages (never the database text: it can echo values).
// Pure, so the mapping is unit-tested.

const MESSAGES: Array<[RegExp, string]> = [
  [/ALREADY_DECIDED/, "Already decided. The list has been refreshed."],
  [/NOT_PROPOSED/, "This type is no longer waiting for a decision. The list has been refreshed."],
  [/DUPLICATE_TYPE|doc_type_name_key/, "An approved type with this name already exists in this group. Use Merge into… instead."],
  [/PERIOD_KIND/, "Some documents are filed for periods this type can't hold. See the list below."],
  [/HAS_DOCUMENTS/, "Documents use this type. Merge it into an approved type instead."],
  [/TARGET_INVALID/, "Choose an approved type the firm collects from clients."],
  [/REASON_REQUIRED/, "Give a reason (up to 500 characters)."],
  [/COMMENT_TOO_LONG/, "The comment can be 500 characters at most."],
  [/NAME_INVALID/, "Enter a name of up to 120 characters."],
  [/ROLE_REQUIRED/, "Only an Admin or Manager can decide proposed types."],
  [/doc_type_offsets|doc_type_overdue_after_ask|doc_type_scheduled_has_period/, "Check the schedule: a scheduled type needs a period and complete ask/overdue days."],
  [/NOT_FOUND/, "Not found — it may have been decided or removed."],
];

export function governanceErrorMessage(message: string | undefined): string {
  return MESSAGES.find(([re]) => re.test(message ?? ""))?.[1] ?? "Couldn't save. Please try again.";
}

/** Someone else decided first: the panel refreshes instead of only showing the error (AC-11). */
export const isStaleDecision = (message: string | undefined) => /ALREADY_DECIDED|NOT_PROPOSED/.test(message ?? "");

/** The staff id the database puts after ALREADY_DECIDED (so the action can show "Already decided by <name>"). */
export function decidedBy(message: string | undefined): string | null {
  const m = /ALREADY_DECIDED:\s*([0-9a-f-]{36})/i.exec(message ?? "");
  return m ? m[1].toLowerCase() : null;
}

export type NotificationDecision = "approved" | "merged" | "rejected";

/** AC-13 notification text. Names are read at display time from the type rows; a client is never named. */
export function notificationText(n: {
  decision: NotificationDecision; name: string; groupName?: string | null; targetName?: string | null; comment?: string | null;
}): string {
  if (n.decision === "merged") return `${n.name} was merged into ${n.targetName ?? "another type"}.`;
  if (n.decision === "rejected") return n.comment ? `${n.name} was rejected: ${n.comment}` : `${n.name} was rejected.`;
  if (n.targetName && n.targetName !== n.name) return `${n.name} was approved as ${n.targetName}${n.groupName ? ` (${n.groupName})` : ""}.`;
  return `${n.name}${n.groupName ? ` (${n.groupName})` : ""} was approved.`;
}
