// Feature 14 — plain messages for the dsc_* database errors (codes only ever reach the screen through this map).

const MESSAGES: Array<[RegExp, string]> = [
  [/DSC_ALREADY_OUT/, "This DSC is already out. Record it as received back first."],
  [/DSC_NOT_OUT/, "This DSC is in the office, so it can't be received back."],
  [/DSC_ARCHIVED/, "This DSC is archived. Unarchive it first."],
  [/CLIENT_ARCHIVED/, "This client is archived."],
  [/DSC_CLIENT_FIXED/, "A DSC stays with its client."],
  [/DATE_IN_FUTURE/, "The date can't be in the future."],
  [/ALREADY_ARCHIVED/, "This DSC is already archived."],
  [/NOT_ARCHIVED/, "This DSC isn't archived."],
  [/DSC_BAD_CIPHERTEXT|DSC_PASSWORD_REQUIRED/, "The password couldn't be saved. Please try again."],
  [/DSC_HOLDER/, "Check the holder's name (1–120 characters)."],
  [/DSC_EXPIRY/, "Enter the expiry date."],
  [/DSC_ISSUER|DSC_NOTE|DSC_PERSON/, "A field is too long."],
  [/REASON_REQUIRED/, "Enter a reason (up to 500 characters)."],
  [/DAYS_INVALID/, "Enter 1 to 180 days."],
  [/ROLE_REQUIRED/, "You don't have permission to do this."],
  [/NOT_FOUND|row-level security|permission denied/, "This DSC or client isn't available to you."],
];

export function dscErrorMessage(dbMessage: string): string {
  return MESSAGES.find(([re]) => re.test(dbMessage))?.[1] ?? "Couldn't save. Please try again.";
}
