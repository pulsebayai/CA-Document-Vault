import { expectedState, isOpen, type ExpectedState } from "./schedule";

// Feature 04 step 4 — pure shaping of expected documents for screens (unit-tested; no I/O).

/** PostgREST select for RawExpected (also run under RLS by tests/rls/expected-docs.test.ts). */
export const EXPECTED_SELECT = `id, status, ask_on, overdue_from, received_on, waived_reason, waived_code, waived_at, registration_id,
  doc_type:doc_type_id (id, name, doc_group:doc_group_id (id, name, sort)),
  period:period_id (id, code, label, start_date, financial_year_id),
  registration:registration_id (id, kind, number),
  completed_by:completed_by_document_id (doc_code),
  waived_by_staff:waived_by (full_name),
  row:client_doc_type_id (state, assigned:assigned_staff_id (full_name), group:client_group_id (state, assigned:assigned_staff_id (full_name)))`;

export type RawExpected = {
  id: string;
  status: "pending" | "received" | "waived";
  ask_on: string;
  overdue_from: string;
  received_on: string | null;
  waived_reason: string | null;
  waived_code: string | null;
  waived_at: string | null;
  registration_id: string | null;
  doc_type: { id: string; name: string; doc_group: { id: string; name: string; sort: number } };
  period: { id: string; code: string; label: string; start_date: string; financial_year_id: string };
  registration: { id: string; kind: "gstin" | "tan"; number: string } | null;
  completed_by: { doc_code: string } | null;
  waived_by_staff: { full_name: string } | null;
  row: { state: string; assigned: { full_name: string } | null; group: { state: string; assigned: { full_name: string } | null } } | null;
};

export type ExpectedItem = {
  id: string;
  groupId: string;
  groupName: string;
  typeId: string;
  typeName: string;
  periodId: string;
  periodLabel: string;
  /** The full GSTIN/TAN, only when the client has more than one active registration of that kind (AC-13). */
  registration: string | null;
  registrationId: string | null;
  status: RawExpected["status"];
  state: ExpectedState;
  open: boolean;
  assignedTo: string | null;
  waivedBy: string | null;
  waivedAt: string | null;
  manualWaiver: boolean;
};

export type StatusFilter = "open" | "received" | "not_needed" | "all";

/** Which kinds of registration the client has more than one of (active), e.g. {gstin} for two active GSTINs. */
export function repeatedKinds(regs: Array<{ kind: string; active: boolean }>): Set<string> {
  const n = new Map<string, number>();
  for (const r of regs) if (r.active) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c > 1).map(([k]) => k));
}

export function toItem(r: RawExpected, today: string, repeated: Set<string>): ExpectedItem {
  const onHold = r.row ? r.row.state === "paused" || r.row.group.state === "paused" : false;
  const state = expectedState({
    status: r.status, overdueFrom: r.overdue_from, onHold, receivedOn: r.received_on,
    docCode: r.completed_by?.doc_code ?? null, waivedReason: r.waived_reason,
  }, today);
  return {
    id: r.id,
    groupId: r.doc_type.doc_group.id,
    groupName: r.doc_type.doc_group.name,
    typeId: r.doc_type.id,
    typeName: r.doc_type.name,
    periodId: r.period.id,
    periodLabel: r.period.label,
    registration: r.registration && repeated.has(r.registration.kind) ? r.registration.number : null,
    registrationId: r.registration_id,
    status: r.status,
    state,
    open: isOpen(state.kind),
    assignedTo: r.row?.assigned?.full_name ?? r.row?.group.assigned?.full_name ?? null,
    waivedBy: r.waived_by_staff?.full_name ?? (r.status === "waived" ? "System" : null),
    waivedAt: r.waived_at,
    manualWaiver: r.waived_code === "manual",
  };
}

/** Status filter of the Expected tab (Open = still pending, including On hold). */
export function matchesStatus(item: ExpectedItem, f: StatusFilter): boolean {
  if (f === "all") return true;
  if (f === "open") return item.status === "pending";
  if (f === "received") return item.status === "received";
  return item.status === "waived";
}

/** Group sort, then type name, then newest period first (AC-13). */
export function sortItems(rows: RawExpected[], items: ExpectedItem[]): ExpectedItem[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...items].sort((a, b) => {
    const ra = byId.get(a.id)!, rb = byId.get(b.id)!;
    return ra.doc_type.doc_group.sort - rb.doc_type.doc_group.sort
      || a.groupName.localeCompare(b.groupName)
      || a.typeName.localeCompare(b.typeName)
      || rb.period.start_date.localeCompare(ra.period.start_date)
      || String(a.registration ?? "").localeCompare(String(b.registration ?? ""));
  });
}

/** Expected tab count (AC-13) and card rows (AC-14): Due + Due today + Overdue. */
export const openCount = (items: ExpectedItem[]) => items.filter((i) => i.open).length;

/** "Today" for 04's rules: the test clock in a test office, otherwise the date in India (private.office_today). */
export function officeToday(office: { is_test: boolean; test_today: string | null } | null, indiaToday: string): string {
  return office?.is_test && office.test_today ? office.test_today : indiaToday;
}

/** Plain messages for the SQL errors of waive / undo / reopen (codes from 20260930120658_expected_docs.sql). */
export function expectedErrorMessage(message: string | undefined): string {
  const m = message ?? "";
  if (/ROLE_REQUIRED/.test(m)) {
    if (/Limited/.test(m)) return "Limited users can't mark items not needed.";
    if (/undo/.test(m)) return "Only an Admin or Manager can undo “Not needed”.";
    return "You don't have permission to do that.";
  }
  if (/REASON_REQUIRED/.test(m)) return "Please give a reason (up to 500 characters).";
  if (/NOT_PENDING/.test(m)) return "This item is no longer open. Reload the page.";
  if (/NOT_WAIVED/.test(m)) return "This item is not marked not needed. Reload the page.";
  if (/NOT_RECEIVED/.test(m)) return "Only a received item can be reopened. Reload the page.";
  if (/NOT_FOUND/.test(m)) return "This item is no longer available. Reload the page.";
  if (/row-level security|permission denied/.test(m)) return "You don't have permission to do that.";
  return "Something went wrong. Please try again.";
}
