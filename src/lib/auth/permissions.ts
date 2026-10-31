import type { Role } from "./roles";

// Feature 08 AC-12: "What each role can do" — the one source for Settings › Users and for
// tests/rls/role-matrix.test.ts, which runs a probe for every row × role (AC-13) and fails when a row has none.
// Each cell was audited against the code (plan step 2, 2026-10-02). Rows "Add, edit and import clients" and
// "Add a financial year" were added at that audit (D4, Raja 2026-10-02): the code enforced them, the spec's
// table didn't show them. "Waive · Reopen" is shown as two rows so each cell has one meaning.
//
// Cell meanings, as the probes test them:
//   yes / all  → allowed on a client the user is assigned to (and, for Limited, would be refused elsewhere)
//   no         → refused
//   assigned   → allowed on an assigned client, refused on another client

export type Cell = "yes" | "no" | "all" | "assigned";

export type PermissionRow = {
  id: string;
  label: string;
  values: Record<Role, Cell>;
  /** Display text when it says more than the cell kind (the probe still tests the kind). */
  labels?: Partial<Record<Role, string>>;
};

const yesAll = { admin: "yes", manager: "yes", staff: "yes" } as const;
const managers = { admin: "yes", manager: "yes", staff: "no", limited: "no" } as const;

export const PERMISSIONS: readonly PermissionRow[] = [
  { id: "see_clients", label: "See clients and their documents", values: { admin: "all", manager: "all", staff: "all", limited: "assigned" } },
  { id: "manage_clients", label: "Add, edit and import clients", values: { ...yesAll, limited: "no" } },
  {
    id: "add_documents", label: "Add documents and file untagged documents", values: { ...yesAll, limited: "assigned" },
    labels: { limited: "Assigned + own untagged" },
  },
  { id: "propose_type", label: "Propose a new type while filing", values: { ...yesAll, limited: "no" } },
  { id: "review_dispatch", label: "Review, mark needs correction, dispatch originals", values: { ...yesAll, limited: "assigned" } },
  // 12 (spec AC-24): split — Staff can undo a review; undoing a dispatch stays Admin/Manager.
  { id: "undo_review", label: "Undo a review", values: { ...yesAll, limited: "no" } },
  { id: "undo_dispatch", label: "Undo a dispatch", values: managers },
  // 13 (spec AC-19, Q5): hard-copy custody — every role, Limited on their clients; undo needs no reason (S3).
  { id: "move_custody", label: "Mark a hard copy in office or ready to dispatch", values: { ...yesAll, limited: "assigned" } },
  { id: "undo_custody", label: "Undo a custody step", values: { ...yesAll, limited: "assigned" } },
  { id: "archive", label: "Archive or unarchive documents and clients", values: managers },
  { id: "waive", label: "Waive an expected document", values: { ...yesAll, limited: "no" } },
  { id: "reopen", label: "Reopen an expected document", values: { ...yesAll, limited: "assigned" } },
  { id: "undo_waive", label: "Undo a waive", values: managers },
  { id: "remind", label: "Remind clients (email, WhatsApp) and log calls", values: { ...yesAll, limited: "assigned" } },
  // 10: anyone who can remind a client can send an upload link; the sender can always revoke their own link.
  { id: "send_upload_link", label: "Send upload links to clients", values: { ...yesAll, limited: "assigned" } },
  { id: "revoke_upload_link", label: "Revoke an upload link someone else sent", values: managers },
  { id: "change_plans", label: "Change collection plans (add, remove types/groups)", values: { ...yesAll, limited: "no" } },
  // 11 (spec AC-6): "Any format is fine for this client" on a plan row — Staff+, like plan changes.
  { id: "format_exception", label: "Set a client's format exception", values: { ...yesAll, limited: "no" } },
  // 14 spec AC-13 (approved Sidambara 2026-10-31): DSC records, reveal, custody, archive.
  { id: "manage_dsc", label: "Add and edit DSCs", values: { ...yesAll, limited: "no" } },
  { id: "reveal_dsc", label: "Reveal a DSC password", values: { ...yesAll, limited: "no" } },
  { id: "log_dsc_custody", label: "Log DSC custody", values: { ...yesAll, limited: "assigned" } },
  { id: "archive_dsc", label: "Archive a DSC", values: managers },
  { id: "assign_pause", label: "Assign incharge and group staff, pause and resume", values: managers },
  { id: "manage_catalogue", label: "Manage catalogue, approve proposed types, Settings › Collection", values: managers },
  { id: "add_financial_year", label: "Add a financial year", values: { admin: "yes", manager: "no", staff: "no", limited: "no" } },
  {
    id: "see_activity", label: "See Activity", values: { admin: "all", manager: "all", staff: "all", limited: "assigned" },
    labels: { limited: "Own + assigned clients" },
  },
  { id: "manage_users", label: "Manage users and roles", values: { admin: "yes", manager: "no", staff: "no", limited: "no" } },
];

const CELL_TEXT: Record<Cell, string> = { yes: "Yes", no: "No", all: "All", assigned: "Assigned" };

/** What the Users page shows in a cell. */
export function cellText(row: PermissionRow, role: Role): string {
  return row.labels?.[role] ?? CELL_TEXT[row.values[role]];
}
