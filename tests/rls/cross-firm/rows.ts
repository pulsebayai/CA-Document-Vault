import type { Firm } from "./seed";

// Feature 18 — which seeded row stands for each table, and which seeded object stands for each referenced table.
// Used by the table cases (spec X4): "Firm B's row" and "Firm B's parent" are always real rows of Firm B.

type Pick = (f: Firm) => string | number;

/** The seeded row of each firm table, found by `column = value`. */
export const ROW: Record<string, { column: string; value: Pick }> = {
  activity: { column: "id", value: (f) => f.ids.activity },
  client: { column: "id", value: (f) => f.ids.client },
  client_contact: { column: "id", value: (f) => f.ids.contact },
  client_doc_type: { column: "id", value: (f) => f.ids.planRow },
  client_dsc_setting: { column: "client_id", value: (f) => f.ids.client },
  client_group: { column: "id", value: (f) => f.ids.clientGroup },
  client_registration: { column: "id", value: (f) => f.ids.registration },
  dispatch: { column: "id", value: (f) => f.ids.dispatch },
  dispatch_item: { column: "id", value: (f) => f.ids.dispatchItem },
  doc_counter: { column: "office_id", value: (f) => f.office },
  doc_group: { column: "id", value: (f) => f.ids.group },
  doc_type: { column: "id", value: (f) => f.ids.proposedType },
  document: { column: "id", value: (f) => f.ids.softDoc },
  document_custody: { column: "id", value: (f) => f.ids.custody },
  document_review: { column: "id", value: (f) => f.ids.review },
  document_version: { column: "id", value: (f) => f.ids.softVersion },
  dsc: { column: "id", value: (f) => f.ids.dsc },
  dsc_custody: { column: "id", value: (f) => f.ids.dscCustody },
  expected_doc: { column: "id", value: (f) => f.ids.expected },
  financial_year: { column: "id", value: (f) => f.ids.financialYear },
  follow_up: { column: "id", value: (f) => f.ids.followUp },
  follow_up_item: { column: "follow_up_id", value: (f) => f.ids.followUp },
  link_attempt: { column: "office_id", value: (f) => f.office },
  notification: { column: "id", value: (f) => f.ids.notification },
  office: { column: "id", value: (f) => f.office },
  period: { column: "id", value: (f) => f.ids.period },
  staff_user: { column: "id", value: (f) => f.users.staff.id },
  upload_request: { column: "id", value: (f) => f.ids.request },
  upload_request_item: { column: "id", value: (f) => f.ids.adHocItem },
};

/** A seeded object of the firm for each table a foreign key can point at. */
export const PARENT: Record<string, Pick> = {
  client: (f) => f.ids.client,
  client_doc_type: (f) => f.ids.planRow,
  client_group: (f) => f.ids.clientGroup,
  client_registration: (f) => f.ids.registration,
  dispatch: (f) => f.ids.dispatch,
  doc_group: (f) => f.ids.group,
  doc_type: (f) => f.ids.bankType,
  document: (f) => f.ids.softDoc,
  document_version: (f) => f.ids.softVersion,
  dsc: (f) => f.ids.dsc,
  expected_doc: (f) => f.ids.expected,
  financial_year: (f) => f.ids.financialYear,
  follow_up: (f) => f.ids.followUp,
  office: (f) => f.office,
  period: (f) => f.ids.period,
  staff_user: (f) => f.users.staff.id,
  upload_request: (f) => f.ids.request,
  upload_request_item: (f) => f.ids.adHocItem,
};

/** A second object of the same kind in the same firm (review I-6): an update control moves a foreign key to it and
 * back, so the control proves a *changed* valid value is accepted, not just a no-op. */
export const PARENT2: Record<string, Pick> = {
  client: (f) => f.ids.client2,
  staff_user: (f) => f.users.admin.id,
  period: (f) => f.ids.laterPeriod,
  doc_type: (f) => f.ids.otherType,
  doc_group: (f) => f.ids.otherGroup,
};
