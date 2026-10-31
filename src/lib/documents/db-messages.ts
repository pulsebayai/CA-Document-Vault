// Document save / edit: database rule codes → plain messages (never the DB text: it can echo values). Pure, so it is
// unit-tested; used by the server actions in ./actions.ts (moved out of it in 13 so it can be tested).

const DB_MESSAGES: Array<[RegExp, string, string?]> = [
  [/SOFT_COPY_NEEDS_FILE/, "Add the file — a soft copy needs one.", "file"],
  [/ITEM_STATE/, "This requested document was cancelled. Go back to Requested and check it."], // 10
  [/ITEM_MISMATCH/, "A requested document is filed with the client, type and period that were requested. Go back to Requested and check it."], // 10
  [/DECLASSIFY/, "A filed document keeps a client and a type. Change them instead of clearing them.", "clientId"],
  [/CLIENT_ARCHIVED/, "This client is archived. Choose another client.", "clientId"],
  [/PERIOD_KIND/, "This period doesn't suit the document type. Choose another period.", "periodId"],
  [/PERIOD_OFFICE/, "Choose the period again.", "periodId"],
  [/REGISTRATION_MISMATCH/, "Choose one of this client's active registrations for this type.", "registrationId"],
  [/TYPE_NOT_OFFERED|TYPE_OFFICE/, "This document type isn't offered for this client. Choose another.", "docTypeId"],
  [/CLIENT_OFFICE|row-level security/, "You can't add documents for this client.", "clientId"],
  [/RECEIVED_ON_FUTURE/, "Received on can't be in the future.", "receivedOn"],
  [/OBJECT_MISSING|FILE_TYPE|PATH/, "The upload didn't finish. Please add the file again.", "file"],
  [/DISPATCHED/, "This document is in a dispatch packet. Undo the dispatch on the document page before changing its client, how it was received or Returnable.", "clientId"], // 07, 12
  [/RETURNABLE_HARD_COPY/, "Only a hard copy can be returnable.", "returnable"], // 12
  [/HANDED_OVER_CLEAR/, "Say who handed it over — it can be changed but not cleared.", "handedOverName"], // 12
  [/HANDED_OVER_NAME|HANDED_OVER_SOFT_COPY/, "Check who handed it over (up to 120 characters, hard copies only).", "handedOverName"], // 12
  // 13 (spec AC-7, S5; pre-PR review I-1): the custody rules refuse these edits until the step is undone.
  [/CUSTODY_SOFT_COPY/, "This document is marked in the office. Undo Document in office on the document page before making it a soft copy.", "receivedAs"],
  [/CUSTODY_READY/, "This document is ready to dispatch. Undo Ready to dispatch on the document page before unticking Returnable.", "returnable"],
  [/ARCHIVED/, "Unarchive the document before changing it."],
  [/NOT_FOUND/, "Document not found."],
];
export function documentDbError(message: string | undefined): { error: string; fieldErrors: Record<string, string> } {
  const hit = DB_MESSAGES.find(([re]) => re.test(message ?? ""));
  if (!hit) return { error: "Couldn't save the document. Please try again.", fieldErrors: {} };
  return { error: hit[1], fieldErrors: hit[2] ? { [hit[2]]: hit[1] } : {} };
}
