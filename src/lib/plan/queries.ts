import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Frequency, PeriodKind } from "@/lib/validation/catalogue";
import type { PeriodRef } from "@/lib/validation/plan";

// Client › Settings: the client's collection plan (spec 02 AC-18 … AC-21, mockup 11).
// Read as the signed-in user, so RLS decides what a Limited user sees (AC-12).

export type PlanState = "active" | "paused" | "removed";
export type PlanType = {
  id: string; docTypeId: string; name: string; periodKind: PeriodKind; frequency: Frequency;
  /** Spec 03 AC-15: a staff-proposed type for this client, waiting for approval (05). */
  proposed?: boolean;
  askAfterMonths: number | null; askDay: number | null; overdueAfterMonths: number | null; overdueDay: number | null;
  reminders: boolean; assignedStaffId: string | null; startPeriodId: string | null;
  state: PlanState; remark: string | null; pausedAt: string | null;
  /** 04 AC-5: collected per GSTIN/TAN — nothing is expected while the client has no active one of that kind. */
  registrationKind: "gstin" | "tan" | null;
  /** 11 (spec AC-5): the type's preferred formats, and whether this client may send any format. */
  preferredFormats?: string[] | null;
  anyFormat?: boolean; // optional: existing callers and tests build plan types without them
};
export type PlanGroup = {
  id: string; docGroupId: string; name: string; state: Exclude<PlanState, "removed">;
  assignedStaffId: string | null; remark: string | null; pausedAt: string | null;
  types: PlanType[];
  /** "+ Add type to <group>": active client-source master types of the group not yet on the client (AC-20). */
  addable: { id: string; name: string }[];
};
export type PlanPeriod = PeriodRef & { label: string; startDate: string; endDate: string };
export type ClientPlan = {
  groups: PlanGroup[];
  /** Active master groups not collected for this client (never enabled, or disabled). */
  otherGroups: { id: string; name: string; wasEnabled: boolean }[];
  periods: PlanPeriod[];
  staff: { id: string; name: string; active: boolean }[];
};

type GroupRow = {
  id: string; doc_group_id: string; assigned_staff_id: string | null; state: PlanState; remark: string | null; paused_at: string | null;
  doc_group: { name: string; sort: number } | null;
};
type TypeRow = {
  id: string; doc_type_id: string; client_group_id: string; frequency: Frequency;
  ask_after_months: number | null; ask_day: number | null; overdue_after_months: number | null; overdue_day: number | null;
  reminders: boolean; assigned_staff_id: string | null; start_period_id: string | null; state: PlanState;
  remark: string | null; paused_at: string | null; any_format: boolean;
  doc_type: { name: string; period_kind: PeriodKind; created_at: string; status: "approved" | "proposed" | "mapped" | "rejected"; registration_kind: "gstin" | "tan" | null; preferred_formats: string[] | null } | null;
};

const RETIRED = new Set(["mapped", "rejected"]);

export async function getClientPlan(clientId: string): Promise<ClientPlan> {
  const supabase = await createClient();
  const [groups, types, masterGroups, masterTypes, periods, staff] = await Promise.all([
    supabase.from("client_group").select("id, doc_group_id, assigned_staff_id, state, remark, paused_at, doc_group(name, sort)")
      .eq("client_id", clientId),
    supabase.from("client_doc_type")
      .select(`id, doc_type_id, client_group_id, frequency, ask_after_months, ask_day, overdue_after_months, overdue_day,
        reminders, assigned_staff_id, start_period_id, state, remark, paused_at, any_format,
        doc_type(name, period_kind, created_at, status, registration_kind, preferred_formats)`)
      .eq("client_id", clientId),
    supabase.from("doc_group").select("id, name").eq("active", true).order("sort").order("name"),
    supabase.from("doc_type").select("id, doc_group_id, name").eq("source", "client").eq("active", true).eq("status", "approved")
      .order("created_at").order("name"),
    supabase.from("period").select("id, kind, label, start_date, end_date").order("start_date").order("kind"),
    supabase.from("staff_user").select("id, full_name, status").order("full_name"),
  ]);
  const failed = [groups, types, masterGroups, masterTypes, periods, staff].find((r) => r.error);
  if (failed) {
    console.error("plan.load_failed", { code: failed.error?.code });
    throw new Error("Could not load the collection plan.");
  }

  const typeRows = (types.data ?? []) as unknown as TypeRow[];
  const onClient = new Set(typeRows.map((t) => t.doc_type_id));
  const groupRows = ((groups.data ?? []) as unknown as GroupRow[]).filter((g) => g.doc_group);
  const live = groupRows.filter((g) => g.state !== "removed").sort((a, b) => a.doc_group!.sort - b.doc_group!.sort);
  const liveIds = new Set(live.map((g) => g.doc_group_id));
  const removedIds = new Set(groupRows.filter((g) => g.state === "removed").map((g) => g.doc_group_id));

  return {
    groups: live.map((g) => ({
      id: g.id, docGroupId: g.doc_group_id, name: g.doc_group!.name, state: g.state as PlanGroup["state"],
      assignedStaffId: g.assigned_staff_id, remark: g.remark, pausedAt: g.paused_at,
      // 05 (pre-PR review I-1): merged and rejected types are retired; their removed rows aren't shown.
      types: typeRows.filter((t) => t.client_group_id === g.id && t.doc_type && !RETIRED.has(t.doc_type.status))
        .sort((a, b) => a.doc_type!.created_at.localeCompare(b.doc_type!.created_at) || a.doc_type!.name.localeCompare(b.doc_type!.name))
        .map((t) => ({
          id: t.id, docTypeId: t.doc_type_id, name: t.doc_type!.name, proposed: t.doc_type!.status === "proposed", periodKind: t.doc_type!.period_kind, frequency: t.frequency,
          askAfterMonths: t.ask_after_months, askDay: t.ask_day, overdueAfterMonths: t.overdue_after_months, overdueDay: t.overdue_day,
          reminders: t.reminders, assignedStaffId: t.assigned_staff_id, startPeriodId: t.start_period_id,
          state: t.state, remark: t.remark, pausedAt: t.paused_at, registrationKind: t.doc_type!.registration_kind,
          preferredFormats: t.doc_type!.preferred_formats ?? null, anyFormat: t.any_format,
        })),
      addable: (masterTypes.data ?? []).filter((m) => m.doc_group_id === g.doc_group_id && !onClient.has(m.id as string))
        .map((m) => ({ id: m.id as string, name: m.name as string })),
    })),
    otherGroups: (masterGroups.data ?? []).filter((g) => !liveIds.has(g.id as string))
      .map((g) => ({ id: g.id as string, name: g.name as string, wasEnabled: removedIds.has(g.id as string) })),
    periods: (periods.data ?? []).map((p) => ({
      id: p.id as string, kind: p.kind as PlanPeriod["kind"], label: p.label as string,
      startDate: p.start_date as string, endDate: p.end_date as string,
    })),
    staff: (staff.data ?? []).map((s) => ({ id: s.id as string, name: s.full_name as string, active: s.status === "active" })),
  };
}
