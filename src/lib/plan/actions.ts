"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff, type CurrentStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/activity";
import type { PeriodKind } from "@/lib/validation/catalogue";
import { validatePlanType, validateRemark, type PeriodRef } from "@/lib/validation/plan";

// Client › Settings — the collection plan (spec 02 AC-19 … AC-21, AC-23).
// Every action checks the role itself (server actions are reachable by direct POST), then writes as the
// signed-in user so RLS, column grants and the plan triggers have the final say:
//   Staff+  enable/disable groups, add/remove/restore types, change frequency, schedule, reminders, start period.
//   Admin/Manager  pause/resume and assign staff (S2: assignment decides what Limited users see).
// Multi-row changes (enable/disable/add) are SQL functions that write their own activity row in the same
// transaction; single-row edits log field names + IDs here. Remarks are free text: never in activity.

export type PlanResult = { ok: true; message: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

const uuid = z.uuid();
const DENIED = "Limited users can't change collection plans.";
const MANAGER_ONLY = "Only an Admin or Manager can pause, resume or assign staff.";
const ARCHIVED = "This client is archived. Unarchive it to change its plan.";
const INVALID = "Invalid request.";

function friendly(message: string | undefined): string {
  const m = message ?? "";
  if (/ROLE_REQUIRED/.test(m)) return /Limited/.test(m) ? DENIED : MANAGER_ONLY;
  if (/row-level security|permission denied/.test(m)) return "You don't have permission to do that.";
  if (/GROUP_NOT_ENABLED/.test(m)) return "Enable the group first.";
  if (/FIRM_RECORD/.test(m)) return "Firm records are never part of a client's plan.";
  if (/INACTIVE_TYPE/.test(m)) return "This type is no longer offered in the catalogue.";
  if (/TYPE_RETIRED/.test(m)) return "This type was merged or rejected, so it can't be collected. Use the type it was merged into.";
  if (/ASSIGNEE/.test(m)) return "Choose an active staff member.";
  if (/NOT_FOUND/.test(m)) return "This client or group is no longer available. Reload the page.";
  if (/offsets|overdue_after_ask/.test(m)) return "Please check the schedule.";
  return "Something went wrong. Please try again.";
}

async function editor(managerOnly = false): Promise<CurrentStaff | { error: string }> {
  const me = await requireStaff();
  if (me.role === "limited") return { error: DENIED };
  if (managerOnly && !canManageCatalogue(me.role)) return { error: MANAGER_ONLY };
  return me;
}

async function clientIsOpen(clientId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("client").select("archived_at").eq("id", clientId).maybeSingle();
  if (!data) return "This client is no longer available.";
  return data.archived_at ? ARCHIVED : null;
}

const done = (clientId: string, message: string): PlanResult => {
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, message };
};

// ── Groups ──────────────────────────────────────────────────────────────────
/** AC-19 / AC-21: enable (or re-enable) a group — copies master types; restores previous rows on re-enable. */
export async function enableGroup(clientId: string, docGroupId: string): Promise<PlanResult> {
  const me = await editor();
  if ("error" in me) return { ok: false, error: me.error };
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(docGroupId).success) return { ok: false, error: INVALID };
  const closed = await clientIsOpen(clientId);
  if (closed) return { ok: false, error: closed };
  const supabase = await createClient();
  const { error } = await supabase.rpc("enable_client_group", { p_client_id: clientId, p_doc_group_id: docGroupId });
  if (error) return { ok: false, error: friendly(error.message) };
  return done(clientId, "Group enabled.");
}

/** AC-21: disable a group — it and its types become removed; nothing is deleted. */
export async function disableGroup(clientId: string, docGroupId: string): Promise<PlanResult> {
  const me = await editor();
  if ("error" in me) return { ok: false, error: me.error };
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(docGroupId).success) return { ok: false, error: INVALID };
  const closed = await clientIsOpen(clientId);
  if (closed) return { ok: false, error: closed };
  const supabase = await createClient();
  const { error } = await supabase.rpc("disable_client_group", { p_client_id: clientId, p_doc_group_id: docGroupId });
  if (error) return { ok: false, error: friendly(error.message) };
  return done(clientId, "Group disabled. Its settings are kept if you enable it again.");
}

type GroupRow = { id: string; client_id: string; state: string; assigned_staff_id: string | null };
async function loadGroup(id: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("client_group").select("id, client_id, state, assigned_staff_id").eq("id", id).maybeSingle<GroupRow>();
  return data;
}

/** AC-20: assign the group to a staff member (Admin/Manager). */
export async function assignGroup(groupRowId: string, staffId: string): Promise<PlanResult> {
  const me = await editor(true);
  if ("error" in me) return { ok: false, error: me.error };
  if (!uuid.safeParse(groupRowId).success || !uuid.safeParse(staffId).success) return { ok: false, error: INVALID };
  const g = await loadGroup(groupRowId);
  if (!g || g.state === "removed") return { ok: false, error: "This group isn't enabled for the client." };
  const closed = await clientIsOpen(g.client_id);
  if (closed) return { ok: false, error: closed };
  if (g.assigned_staff_id === staffId) return { ok: true, message: "No changes." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_group").update({ assigned_staff_id: staffId }).eq("id", g.id).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "client_group.assigned", entityType: "client_group", entityId: g.id,
    data: { client_id: g.client_id, fields: ["assigned_staff_id"], assigned_staff_id: staffId } });
  return done(g.client_id, "Assignment saved.");
}

// ── Pause / resume (Admin/Manager, AC-20) ──────────────────────────────────
type Kind = "group" | "type";
const TABLE: Record<Kind, "client_group" | "client_doc_type"> = { group: "client_group", type: "client_doc_type" };

async function loadItem(kind: Kind, id: string) {
  const supabase = await createClient();
  const { data } = await supabase.from(TABLE[kind]).select("id, client_id, state").eq("id", id)
    .maybeSingle<{ id: string; client_id: string; state: string }>();
  return data;
}

export async function pausePlanItem(kind: Kind, id: string, remarkInput: string): Promise<PlanResult> {
  const me = await editor(true);
  if ("error" in me) return { ok: false, error: me.error };
  if (!(kind in TABLE) || !uuid.safeParse(id).success) return { ok: false, error: INVALID };
  const { remark, error: remarkError } = validateRemark(remarkInput);
  if (remarkError) return { ok: false, error: remarkError, fieldErrors: { remark: remarkError } };
  const row = await loadItem(kind, id);
  if (!row || row.state !== "active") return { ok: false, error: "Only an active item can be paused." };
  const closed = await clientIsOpen(row.client_id);
  if (closed) return { ok: false, error: closed };
  const supabase = await createClient();
  const { data, error } = await supabase.from(TABLE[kind]).update({ state: "paused", remark }).eq("id", id).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: `${TABLE[kind]}.paused`, entityType: TABLE[kind], entityId: id,
    data: { client_id: row.client_id, fields: remark ? ["state", "remark"] : ["state"] } });
  return done(row.client_id, "Paused.");
}

export async function resumePlanItem(kind: Kind, id: string): Promise<PlanResult> {
  const me = await editor(true);
  if ("error" in me) return { ok: false, error: me.error };
  if (!(kind in TABLE) || !uuid.safeParse(id).success) return { ok: false, error: INVALID };
  const row = await loadItem(kind, id);
  if (!row || row.state !== "paused") return { ok: false, error: "This item isn't paused." };
  const closed = await clientIsOpen(row.client_id);
  if (closed) return { ok: false, error: closed };
  const supabase = await createClient();
  const { data, error } = await supabase.from(TABLE[kind]).update({ state: "active", remark: null }).eq("id", id).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: `${TABLE[kind]}.resumed`, entityType: TABLE[kind], entityId: id,
    data: { client_id: row.client_id, fields: ["state", "remark"] } });
  return done(row.client_id, "Resumed.");
}

// ── Types ───────────────────────────────────────────────────────────────────
/** AC-20 "+ Add type to <group>": copies the master's defaults (DB function logs the activity). */
export async function addPlanType(clientId: string, docTypeId: string): Promise<PlanResult> {
  const me = await editor();
  if ("error" in me) return { ok: false, error: me.error };
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(docTypeId).success) return { ok: false, error: INVALID };
  const closed = await clientIsOpen(clientId);
  if (closed) return { ok: false, error: closed };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_client_doc_type", { p_client_id: clientId, p_doc_type_id: docTypeId });
  if (error) return { ok: false, error: friendly(error.message) };
  return done(clientId, "Type added.");
}

type PlanTypeRow = {
  id: string; client_id: string; client_group_id: string; state: string; frequency: string; reminders: boolean;
  ask_after_months: number | null; ask_day: number | null; overdue_after_months: number | null; overdue_day: number | null;
  start_period_id: string | null; assigned_staff_id: string | null; any_format: boolean;
  doc_type: { period_kind: PeriodKind; preferred_formats: string[] | null } | null; client_group: { state: string } | null;
};
async function loadType(id: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("client_doc_type")
    .select(`id, client_id, client_group_id, state, frequency, reminders, ask_after_months, ask_day, overdue_after_months, overdue_day,
      start_period_id, assigned_staff_id, any_format, doc_type(period_kind, preferred_formats), client_group(state)`)
    .eq("id", id).maybeSingle();
  return data as unknown as PlanTypeRow | null;
}

/** AC-20: remove (doesn't apply to this client) or restore a type. Paused types are resumed first (Admin/Manager). */
export async function setPlanTypeActive(id: string, active: boolean): Promise<PlanResult> {
  const me = await editor();
  if ("error" in me) return { ok: false, error: me.error };
  if (!uuid.safeParse(id).success || typeof active !== "boolean") return { ok: false, error: INVALID };
  const t = await loadType(id);
  if (!t || !t.client_group || t.client_group.state === "removed") return { ok: false, error: "Enable the group first." };
  if (t.state === "paused") return { ok: false, error: "Resume this type first." };
  const closed = await clientIsOpen(t.client_id);
  if (closed) return { ok: false, error: closed };
  const next = active ? "active" : "removed";
  if (t.state === next) return { ok: true, message: "No changes." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_doc_type").update({ state: next }).eq("id", id).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: active ? "client_doc_type.restored" : "client_doc_type.removed",
    entityType: "client_doc_type", entityId: id, data: { client_id: t.client_id, fields: ["state"] } });
  return done(t.client_id, active ? "Type restored." : "Type removed for this client.");
}

/**
 * 11 (spec AC-5…AC-8): "Any format is fine for this client" on one plan row. Staff+ only (the action checks the role;
 * client_doc_type's RLS refuses Limited anyway, plan P1). Affects only documents filed afterwards.
 */
export async function setPlanTypeAnyFormat(id: string, on: boolean): Promise<PlanResult> {
  const me = await editor();
  if ("error" in me) return { ok: false, error: me.error };
  if (!uuid.safeParse(id).success || typeof on !== "boolean") return { ok: false, error: INVALID };
  const t = await loadType(id);
  if (!t) return { ok: false, error: "This type is no longer available." };
  const closed = await clientIsOpen(t.client_id);
  if (closed) return { ok: false, error: closed };
  if (t.any_format === on) return { ok: true, message: "No changes." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_doc_type").update({ any_format: on }).eq("id", id).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied") };
  await logActivity({ officeId: me.officeId, actorId: me.id,
    action: on ? "client_doc_type.format_exception_set" : "client_doc_type.format_exception_cleared",
    entityType: "client_doc_type", entityId: id, data: { client_id: t.client_id } });
  return done(t.client_id, on ? "Any format is fine for this client." : "Preferred formats apply to this client again.");
}

/** Reminders switch on a row (mockup 11). Only scheduled types send reminders. */
export async function setPlanTypeReminders(id: string, on: boolean): Promise<PlanResult> {
  const me = await editor();
  if ("error" in me) return { ok: false, error: me.error };
  if (!uuid.safeParse(id).success || typeof on !== "boolean") return { ok: false, error: INVALID };
  const t = await loadType(id);
  if (!t) return { ok: false, error: "This type is no longer available." };
  if (t.state !== "active" || !t.client_group || t.client_group.state === "removed") return { ok: false, error: "Only an active type can change its reminders." };
  if (on && t.frequency === "as_needed") return { ok: false, error: "Set a schedule first — “as needed” types have no reminders." };
  const closed = await clientIsOpen(t.client_id);
  if (closed) return { ok: false, error: closed };
  if (t.reminders === on) return { ok: true, message: "No changes." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_doc_type").update({ reminders: on }).eq("id", id).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "client_doc_type.updated", entityType: "client_doc_type", entityId: id,
    data: { client_id: t.client_id, fields: ["reminders"] } });
  return done(t.client_id, on ? "Reminders on." : "Reminders off.");
}

/**
 * Type dialog (AC-20): frequency + schedule + reminders + start period for Staff+; the assigned-staff override
 * only for Admin/Manager (the field is ignored for others, and the DB trigger refuses it anyway).
 */
export async function savePlanType(_prev: PlanResult | null, form: FormData): Promise<PlanResult> {
  const me = await editor();
  if ("error" in me) return { ok: false, error: me.error };
  const id = String(form.get("id") ?? "");
  if (!uuid.safeParse(id).success) return { ok: false, error: INVALID };
  const t = await loadType(id);
  if (!t || !t.doc_type) return { ok: false, error: "This type is no longer available." };
  const closed = await clientIsOpen(t.client_id);
  if (closed) return { ok: false, error: closed };

  const supabase = await createClient();
  const { data: periodRows } = await supabase.from("period").select("id, kind");
  const periods = (periodRows ?? []) as PeriodRef[];
  const v = validatePlanType({
    frequency: form.get("frequency") ?? undefined, askAfterMonths: form.get("askAfterMonths") ?? undefined,
    askDay: form.get("askDay") ?? undefined, overdueAfterMonths: form.get("overdueAfterMonths") ?? undefined,
    overdueDay: form.get("overdueDay") ?? undefined, reminders: form.get("reminders") ?? undefined,
    startPeriodId: form.get("startPeriodId") ?? undefined,
  }, { periodKind: t.doc_type.period_kind, periods });
  if (!v.data) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: Object.fromEntries(v.errors.map((e) => [e.field, e.message])) };
  }

  const next: Record<string, unknown> = {
    frequency: v.data.frequency, ask_after_months: v.data.askAfterMonths, ask_day: v.data.askDay,
    overdue_after_months: v.data.overdueAfterMonths, overdue_day: v.data.overdueDay, reminders: v.data.reminders,
    start_period_id: v.data.startPeriodId,
  };
  if (canManageCatalogue(me.role) && form.has("assignedStaffId")) {
    const a = String(form.get("assignedStaffId") ?? "");
    if (a && !uuid.safeParse(a).success) return { ok: false, error: INVALID };
    next.assigned_staff_id = a || null; // empty = the group's assignee
  }
  const changed = Object.keys(next).filter((k) => next[k] !== (t as unknown as Record<string, unknown>)[k]);
  if (!changed.length) return done(t.client_id, "No changes.");
  const { data, error } = await supabase.from("client_doc_type").update(next).eq("id", id).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "client_doc_type.updated", entityType: "client_doc_type", entityId: id,
    data: { client_id: t.client_id, fields: changed } });
  return done(t.client_id, "Saved.");
}
