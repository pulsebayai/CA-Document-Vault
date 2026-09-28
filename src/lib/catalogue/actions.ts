"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff, type CurrentStaff } from "@/lib/auth/staff";
import { canAddFinancialYear, canManageCatalogue } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/activity";
import {
  codeFromName, PERIOD_KINDS, validateDocGroup, validateDocType, type DocSource, type PeriodKind,
} from "@/lib/validation/catalogue";

// Settings › Document catalogue (spec 02 AC-2, AC-3, AC-5, AC-6).
// Every action checks the role itself (server actions are reachable by direct POST) and then writes
// as the signed-in user, so RLS is the final say. Activity rows hold field names and IDs only (AC-23).

export type CatalogueResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const PATH = "/settings/catalogue";
const DENIED_MSG = "Only an Admin or Manager can change the catalogue.";
const id = z.uuid();
const suffix = () => randomBytes(3).toString("hex");

async function requireCatalogueEditor(): Promise<CurrentStaff | null> {
  const me = await requireStaff();
  return canManageCatalogue(me.role) ? me : null;
}

function friendly(message: string | undefined, what: "type" | "group"): string {
  if (!message) return "Something went wrong. Please try again.";
  if (/duplicate key/.test(message)) return what === "type" ? "A type with this name already exists in this group." : "A group with this name already exists.";
  if (/row-level security|permission denied|ROLE_REQUIRED/.test(message)) return DENIED_MSG;
  if (/doc_type_overdue_after_ask/.test(message)) return "Overdue must be on or after the ask date.";
  return "Something went wrong. Please try again.";
}

const fieldErrors = (errors: { field: string; message: string }[]) =>
  Object.fromEntries(errors.map((e) => [e.field, e.message]));

type TypeRow = {
  id: string; doc_group_id: string; source: DocSource; period_kind: PeriodKind; name: string; aliases: string[];
  default_frequency: string; ask_after_months: number | null; ask_day: number | null; overdue_after_months: number | null;
  overdue_day: number | null; reminders: boolean; used_for: string | null; active: boolean;
};

/** Add or edit a document type or firm record (AC-2). `id` present = edit. */
export async function saveDocType(_prev: CatalogueResult | null, form: FormData): Promise<CatalogueResult> {
  const me = await requireCatalogueEditor();
  if (!me) return { ok: false, error: DENIED_MSG };
  const supabase = await createClient();
  const typeId = String(form.get("id") ?? "");
  const input = Object.fromEntries(
    ["name", "aliases", "frequency", "askAfterMonths", "askDay", "overdueAfterMonths", "overdueDay", "reminders", "usedFor", "active"]
      .map((k) => [k, form.get(k) ?? undefined]),
  );

  if (typeId) {
    if (!id.safeParse(typeId).success) return { ok: false, error: "Invalid request." };
    const { data: old } = await supabase.from("doc_type")
      .select("id, doc_group_id, source, period_kind, name, aliases, default_frequency, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, used_for, active")
      .eq("id", typeId).maybeSingle<TypeRow>();
    if (!old) return { ok: false, error: "This type no longer exists." };
    const v = validateDocType(input, { source: old.source, periodKind: old.period_kind });
    if (!v.data) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(v.errors) };
    const next = {
      name: v.data.name, aliases: v.data.aliases, default_frequency: v.data.defaultFrequency,
      ask_after_months: v.data.askAfterMonths, ask_day: v.data.askDay, overdue_after_months: v.data.overdueAfterMonths,
      overdue_day: v.data.overdueDay, reminders: v.data.reminders, used_for: v.data.usedFor, active: v.data.active,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[])
      .filter((k) => JSON.stringify(next[k]) !== JSON.stringify(old[k]));
    if (!changed.length) return { ok: true, message: "No changes." };
    const { data, error } = await supabase.from("doc_type").update(next).eq("id", typeId).select("id");
    if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied", "type") };
    await logActivity({ officeId: me.officeId, actorId: me.id, action: "doc_type.updated", entityType: "doc_type", entityId: typeId, data: { fields: changed } });
    revalidatePath(PATH);
    return { ok: true, message: `Saved “${v.data.name}”.` };
  }

  const groupId = String(form.get("groupId") ?? "");
  const source = form.get("source") === "firm" ? "firm" : "client";
  const periodKind = String(form.get("periodKind") ?? "") as PeriodKind;
  if (!id.safeParse(groupId).success) return { ok: false, error: "Choose a group.", fieldErrors: { groupId: "Choose a group." } };
  if (!PERIOD_KINDS.includes(periodKind)) return { ok: false, error: "Choose a period.", fieldErrors: { periodKind: "Choose a period." } };
  const v = validateDocType({ ...input, active: "on" }, { source, periodKind });
  if (!v.data) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(v.errors) };
  const { data, error } = await supabase.from("doc_type").insert({
    office_id: me.officeId, doc_group_id: groupId, code: codeFromName(v.data.name, suffix()), name: v.data.name,
    aliases: v.data.aliases, period_kind: periodKind, default_frequency: v.data.defaultFrequency, source,
    used_for: v.data.usedFor, ask_after_months: v.data.askAfterMonths, ask_day: v.data.askDay,
    overdue_after_months: v.data.overdueAfterMonths, overdue_day: v.data.overdueDay, reminders: v.data.reminders,
  }).select("id").single();
  if (error || !data) return { ok: false, error: friendly(error?.message, "type") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "doc_type.created", entityType: "doc_type", entityId: data.id, data: { doc_group_id: groupId, source } });
  revalidatePath(PATH);
  return { ok: true, message: `Added “${v.data.name}”.` };
}

/** Inline reminders switch on a type row (mockup 05). Only scheduled client documents have reminders. */
export async function setTypeReminders(typeId: string, on: boolean): Promise<CatalogueResult> {
  const me = await requireCatalogueEditor();
  if (!me) return { ok: false, error: DENIED_MSG };
  if (!id.safeParse(typeId).success || typeof on !== "boolean") return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("doc_type").update({ reminders: on })
    .eq("id", typeId).eq("source", "client").neq("default_frequency", "as_needed").select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied", "type") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "doc_type.updated", entityType: "doc_type", entityId: typeId, data: { fields: ["reminders"] } });
  revalidatePath(PATH);
  return { ok: true, message: on ? "Reminders on." : "Reminders off." };
}

/** Add or rename/deactivate a group (AC-3). `id` present = edit. */
export async function saveDocGroup(_prev: CatalogueResult | null, form: FormData): Promise<CatalogueResult> {
  const me = await requireCatalogueEditor();
  if (!me) return { ok: false, error: DENIED_MSG };
  const v = validateDocGroup({ name: form.get("name") ?? undefined });
  if (!v.data) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(v.errors) };
  const supabase = await createClient();
  const groupId = String(form.get("id") ?? "");

  if (groupId) {
    if (!id.safeParse(groupId).success) return { ok: false, error: "Invalid request." };
    const active = form.get("active") === "on";
    const { data: old } = await supabase.from("doc_group").select("name, active").eq("id", groupId).maybeSingle();
    if (!old) return { ok: false, error: "This group no longer exists." };
    const changed = [old.name !== v.data.name && "name", old.active !== active && "active"].filter(Boolean) as string[];
    if (!changed.length) return { ok: true, message: "No changes." };
    const { data, error } = await supabase.from("doc_group").update({ name: v.data.name, active }).eq("id", groupId).select("id");
    if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied", "group") };
    await logActivity({ officeId: me.officeId, actorId: me.id, action: "doc_group.updated", entityType: "doc_group", entityId: groupId, data: { fields: changed } });
    revalidatePath(PATH);
    return { ok: true, message: `Saved “${v.data.name}”.` };
  }

  const { data: last } = await supabase.from("doc_group").select("sort").order("sort", { ascending: false }).limit(1).maybeSingle();
  const { data, error } = await supabase.from("doc_group").insert({
    office_id: me.officeId, code: codeFromName(v.data.name, suffix()), name: v.data.name, sort: (last?.sort ?? 0) + 10,
  }).select("id").single();
  if (error || !data) return { ok: false, error: friendly(error?.message, "group") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "doc_group.created", entityType: "doc_group", entityId: data.id });
  revalidatePath(PATH);
  return { ok: true, message: `Added “${v.data.name}”.` };
}

/** "Enabled for new clients" switch (AC-3): only the default ticks on Add client / Import. */
export async function setGroupEnabledForNew(groupId: string, on: boolean): Promise<CatalogueResult> {
  const me = await requireCatalogueEditor();
  if (!me) return { ok: false, error: DENIED_MSG };
  if (!id.safeParse(groupId).success || typeof on !== "boolean") return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("doc_group").update({ enabled_for_new_clients: on }).eq("id", groupId).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message ?? "permission denied", "group") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "doc_group.updated", entityType: "doc_group", entityId: groupId, data: { fields: ["enabled_for_new_clients"] } });
  revalidatePath(PATH);
  return { ok: true, message: on ? "Enabled for new clients." : "Not enabled for new clients." };
}

/** Reorder (AC-3): swap the sort value with the neighbouring active group. */
export async function moveGroup(groupId: string, direction: "up" | "down"): Promise<CatalogueResult> {
  const me = await requireCatalogueEditor();
  if (!me) return { ok: false, error: DENIED_MSG };
  if (!id.safeParse(groupId).success || !["up", "down"].includes(direction)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data: rows } = await supabase.from("doc_group").select("id, sort").eq("active", true).order("sort").order("name");
  const list = rows ?? [];
  const i = list.findIndex((g) => g.id === groupId);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return { ok: true, message: "No changes." };
  const [a, b] = [list[i], list[j]];
  // Equal sort values would make the swap a no-op; spread them apart first.
  const [sa, sb] = a.sort === b.sort ? [b.sort + (direction === "up" ? -1 : 1), a.sort] : [b.sort, a.sort];
  const r1 = await supabase.from("doc_group").update({ sort: sa }).eq("id", a.id).select("id");
  const r2 = await supabase.from("doc_group").update({ sort: sb }).eq("id", b.id).select("id");
  if (r1.error || r2.error || !r1.data?.length || !r2.data?.length) return { ok: false, error: friendly((r1.error ?? r2.error)?.message ?? "permission denied", "group") };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "doc_group.reordered", entityType: "doc_group", entityId: groupId, data: { direction } });
  revalidatePath(PATH);
  return { ok: true, message: "Order saved." };
}

/** AC-5: Admin adds the next FY with its 17 periods (the SQL function checks the role and logs activity). */
export async function addFinancialYear(): Promise<CatalogueResult> {
  const me = await requireStaff();
  if (!canAddFinancialYear(me.role)) return { ok: false, error: "Only an Admin can add a financial year." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_financial_year");
  if (error) {
    if (/duplicate key/.test(error.message)) return { ok: false, error: "That financial year already exists." };
    if (/ROLE_REQUIRED/.test(error.message)) return { ok: false, error: "Only an Admin can add a financial year." };
    console.error("catalogue.add_fy_failed", { code: error.code });
    return { ok: false, error: "Could not add the financial year. Please try again." };
  }
  revalidatePath(PATH);
  return { ok: true, message: "Financial year added." };
}
