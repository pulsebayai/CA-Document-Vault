import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Frequency, PeriodKind } from "@/lib/validation/catalogue";
import { CLIENT_DOCUMENTS_SELECT, INBOX_SELECT } from "./selects";

// Spec 03 — data for Add document / Assign (AC-3, AC-15). Read as the signed-in user: RLS decides.

export type TypeOption = {
  id: string; name: string; groupId: string; groupName: string; periodKind: PeriodKind;
  /** The client's own frequency when the type is in the plan, else the master default. */
  frequency: Frequency;
  registrationKind: "gstin" | "tan" | null;
  proposed: boolean;
};
export type RegistrationOption = { id: string; kind: "gstin" | "tan"; number: string };
export type PeriodOption = { id: string; kind: Exclude<PeriodKind, "none">; code: string; label: string; fyCode: string };
export type ClientTypes = { planTypes: TypeOption[]; otherTypes: TypeOption[]; registrations: RegistrationOption[] };
export type ClientOption = { id: string; name: string; code: string };

type TypeRow = {
  id: string; name: string; doc_group_id: string; period_kind: PeriodKind; default_frequency: Frequency;
  registration_kind: "gstin" | "tan" | null; status: "approved" | "proposed"; proposed_for_client_id: string | null;
  doc_group: { name: string; sort: number; active: boolean } | null;
};

const byGroupThenName = (a: TypeOption & { sort: number }, b: TypeOption & { sort: number }) =>
  a.sort - b.sort || a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name);

/**
 * AC-3: "the client's active plan types first, then Other types (every approved active type)".
 * Without a client: every approved active type (Inbox / header add).
 */
export async function typesForClient(clientId: string | null): Promise<ClientTypes> {
  const supabase = await createClient();
  const [types, plan, regs] = await Promise.all([
    supabase.from("doc_type")
      .select("id, name, doc_group_id, period_kind, default_frequency, registration_kind, status, proposed_for_client_id, doc_group:doc_group_id (name, sort, active)")
      .eq("active", true),
    clientId
      ? supabase.from("client_doc_type").select("doc_type_id, frequency").eq("client_id", clientId).eq("state", "active")
      : Promise.resolve({ data: [] as { doc_type_id: string; frequency: Frequency }[], error: null }),
    clientId
      ? supabase.from("client_registration").select("id, kind, number").eq("client_id", clientId).eq("active", true).order("number")
      : Promise.resolve({ data: [] as RegistrationOption[], error: null }),
  ]);
  const failed = [types, plan, regs].find((r) => r.error);
  if (failed) {
    console.error("documents.types_failed", { code: failed.error?.code });
    throw new Error("Could not load document types.");
  }
  const inPlan = new Map((plan.data ?? []).map((p) => [p.doc_type_id, p.frequency]));
  const all = ((types.data ?? []) as unknown as TypeRow[])
    .filter((t) => t.doc_group?.active)
    .filter((t) => t.status === "approved" || (clientId && t.proposed_for_client_id === clientId))
    .map((t) => ({
      id: t.id, name: t.name, groupId: t.doc_group_id, groupName: t.doc_group!.name, sort: t.doc_group!.sort,
      periodKind: t.period_kind, frequency: inPlan.get(t.id) ?? t.default_frequency,
      registrationKind: t.registration_kind, proposed: t.status === "proposed",
    }))
    .sort(byGroupThenName);
  const strip = (t: TypeOption & { sort: number }): TypeOption => ({
    id: t.id, name: t.name, groupId: t.groupId, groupName: t.groupName, periodKind: t.periodKind,
    frequency: t.frequency, registrationKind: t.registrationKind, proposed: t.proposed,
  });
  return {
    planTypes: all.filter((t) => inPlan.has(t.id)).map(strip),
    otherTypes: all.filter((t) => !inPlan.has(t.id) && !t.proposed).map(strip),
    registrations: (regs.data ?? []) as RegistrationOption[],
  };
}

export async function listPeriods(): Promise<PeriodOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("period")
    .select("id, kind, code, label, start_date, financial_year:financial_year_id (code)")
    .order("start_date", { ascending: false });
  if (error) throw new Error("Could not load periods.");
  return (data ?? []).map((p) => ({
    id: p.id, kind: p.kind, code: p.code, label: p.label,
    fyCode: (p.financial_year as unknown as { code: string }).code,
  }));
}

export async function listGroups(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("doc_group").select("id, name").eq("active", true).order("sort").order("name");
  if (error) throw new Error("Could not load groups.");
  return data ?? [];
}

/** The pre-filled client (from ?client=), if the user can see it and it isn't archived. */
export async function clientOption(id: string): Promise<ClientOption | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("client").select("id, name, code, archived_at").eq("id", id).maybeSingle();
  return data && !data.archived_at ? { id: data.id, name: data.name, code: data.code } : null;
}

// ── Inbox (AC-7 … AC-9) ──────────────────────────────────────────────────────
export type InboxItem = {
  id: string; docCode: string; fileName: string | null; receivedAs: "soft_copy" | "hard_copy" | "original";
  channel: string; remark: string | null; addedBy: string; createdAt: string;
  clientName: string | null; typeName: string | null;
};

type InboxRow = {
  id: string; doc_code: string; received_as: InboxItem["receivedAs"]; channel: string; remark: string | null; created_at: string;
  creator: { full_name: string } | null; current: { file_name: string } | null;
  client: { name: string } | null; doc_type: { name: string } | null;
};

/** Unclassified, not archived, newest first. RLS: Staff+ see all; Limited only what they added (AC-9). */
/** `onlyAddedBy`: a Limited user's Inbox is what they added (AC-7/9); RLS alone also shows unclassified items of their clients. */
export async function listInbox(onlyAddedBy: string | null, limit = 200): Promise<InboxItem[]> {
  const supabase = await createClient();
  let q = supabase.from("document").select(INBOX_SELECT).is("classified_at", null).is("archived_at", null);
  if (onlyAddedBy) q = q.eq("created_by", onlyAddedBy);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) {
    console.error("documents.inbox_failed", { code: error.code });
    throw new Error("Could not load the Inbox.");
  }
  return ((data ?? []) as unknown as InboxRow[]).map((r) => ({
    id: r.id, docCode: r.doc_code, fileName: r.current?.file_name ?? null, receivedAs: r.received_as, channel: r.channel,
    remark: r.remark, addedBy: r.creator?.full_name ?? "—", createdAt: r.created_at,
    clientName: r.client?.name ?? null, typeName: r.doc_type?.name ?? null,
  }));
}

/** Nav badge (AC-7): what this user's Inbox holds. */
export async function inboxCount(onlyAddedBy: string | null): Promise<number> {
  const supabase = await createClient();
  let q = supabase.from("document").select("id", { count: "exact", head: true }).is("classified_at", null).is("archived_at", null);
  if (onlyAddedBy) q = q.eq("created_by", onlyAddedBy);
  const { count } = await q;
  return count ?? 0;
}

// ── One document, for Assign / edit (AC-8, AC-11) ───────────────────────────
export type DocumentForForm = {
  id: string; docCode: string; client: ClientOption | null; docTypeId: string | null; periodId: string | null;
  registrationId: string | null; receivedAs: "soft_copy" | "hard_copy" | "original"; channel: string; receivedOn: string;
  remark: string | null; fileName: string | null; versionCount: number; classified: boolean; archived: boolean;
};

export async function getDocumentForForm(id: string): Promise<DocumentForForm | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("document")
    .select(`id, doc_code, doc_type_id, period_id, registration_id, received_as, channel, received_on, remark, version_count,
      classified_at, archived_at, client:client_id (id, name, code), current:current_version_id (file_name)`)
    .eq("id", id).maybeSingle();
  if (!data) return null;
  const client = data.client as unknown as ClientOption | null;
  return {
    id: data.id, docCode: data.doc_code, client: client ? { id: client.id, name: client.name, code: client.code } : null,
    docTypeId: data.doc_type_id, periodId: data.period_id, registrationId: data.registration_id,
    receivedAs: data.received_as, channel: data.channel, receivedOn: data.received_on, remark: data.remark,
    fileName: (data.current as unknown as { file_name: string } | null)?.file_name ?? null,
    versionCount: data.version_count, classified: !!data.classified_at, archived: !!data.archived_at,
  };
}

// ── Client › Documents (AC-10) ───────────────────────────────────────────────
export type ClientDocument = {
  id: string; docCode: string; typeName: string; groupId: string; groupName: string; groupSort: number;
  periodLabel: string | null; periodStart: string | null; fyCode: string; receivedOn: string; receivedBy: string;
  receivedAs: "soft_copy" | "hard_copy" | "original"; versionCount: number;
  current: { id: string; mimeType: string } | null; proposed: boolean;
};

type ClientDocRow = {
  id: string; doc_code: string; received_on: string; received_as: ClientDocument["receivedAs"]; version_count: number;
  receiver: { full_name: string } | null;
  doc_type: { name: string; status: string; doc_group: { id: string; name: string; sort: number } | null } | null;
  period: { label: string; start_date: string; financial_year: { code: string } | null } | null;
  current: { id: string; mime_type: string } | null;
};

/**
 * Received, classified, not archived documents of one client. FY = the period's FY; undated documents
 * (no period) count in the FY of their received-on date. RLS: Limited users only reach clients they can see.
 */
export async function listClientDocuments(clientId: string): Promise<ClientDocument[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("document")
    .select(CLIENT_DOCUMENTS_SELECT)
    .eq("client_id", clientId).not("classified_at", "is", null).is("archived_at", null)
    .order("received_on", { ascending: false }).limit(2000);
  if (error) {
    console.error("documents.client_list_failed", { code: error.code });
    throw new Error("Could not load documents.");
  }
  return ((data ?? []) as unknown as ClientDocRow[]).filter((r) => r.doc_type?.doc_group).map((r) => ({
    id: r.id, docCode: r.doc_code, typeName: r.doc_type!.name, groupId: r.doc_type!.doc_group!.id,
    groupName: r.doc_type!.doc_group!.name, groupSort: r.doc_type!.doc_group!.sort,
    periodLabel: r.period?.label ?? null, periodStart: r.period?.start_date ?? null,
    fyCode: r.period?.financial_year?.code ?? fyOfDate(r.received_on),
    receivedOn: r.received_on, receivedBy: r.receiver?.full_name ?? "—", receivedAs: r.received_as,
    versionCount: r.version_count, current: r.current ? { id: r.current.id, mimeType: r.current.mime_type } : null,
    proposed: r.doc_type!.status === "proposed",
  }));
}

export async function countClientDocuments(clientId: string): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase.from("document").select("id", { count: "exact", head: true })
    .eq("client_id", clientId).not("classified_at", "is", null).is("archived_at", null);
  return count ?? 0;
}

function fyOfDate(d: string): string {
  const [y, m] = d.split("-").map(Number);
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, "0")}`;
}

// ── Document page (AC-11) ────────────────────────────────────────────────────
export type DocumentDetail = DocumentForForm & {
  typeName: string | null; groupName: string | null; periodLabel: string | null; registrationNumber: string | null;
  receivedBy: string; addedBy: string; createdAt: string; archivedAt: string | null; archiveReason: string | null;
  currentVersionId: string | null;
  versions: { id: string; versionNo: number; fileName: string; mimeType: string; sizeBytes: number; uploadedAt: string; uploadedBy: string }[];
  activity: { action: string; actor: string; at: string }[];
};

export async function getDocumentDetail(id: string): Promise<DocumentDetail | null> {
  const base = await getDocumentForForm(id);
  if (!base) return null;
  const supabase = await createClient();
  const [doc, versions, activity] = await Promise.all([
    supabase.from("document").select(`created_at, archived_at, archive_reason, current_version_id,
        receiver:received_by (full_name), creator:created_by (full_name),
        doc_type:doc_type_id (name, doc_group:doc_group_id (name)), period:period_id (label), registration:registration_id (number)`)
      .eq("id", id).single(),
    supabase.from("document_version").select("id, version_no, file_name, mime_type, size_bytes, uploaded_at, uploader:uploaded_by (full_name)")
      .eq("document_id", id).order("version_no", { ascending: false }),
    supabase.from("activity").select("action, created_at, actor:actor_id (full_name)")
      .eq("entity_type", "document").eq("entity_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  if (doc.error || versions.error) throw new Error("Could not load the document.");
  const d = doc.data as unknown as {
    created_at: string; archived_at: string | null; archive_reason: string | null; current_version_id: string | null;
    receiver: { full_name: string } | null; creator: { full_name: string } | null;
    doc_type: { name: string; doc_group: { name: string } | null } | null; period: { label: string } | null;
    registration: { number: string } | null;
  };
  return {
    ...base,
    typeName: d.doc_type?.name ?? null, groupName: d.doc_type?.doc_group?.name ?? null, periodLabel: d.period?.label ?? null,
    registrationNumber: d.registration?.number ?? null, receivedBy: d.receiver?.full_name ?? "—", addedBy: d.creator?.full_name ?? "—",
    createdAt: d.created_at, archivedAt: d.archived_at, archiveReason: d.archive_reason, currentVersionId: d.current_version_id,
    versions: ((versions.data ?? []) as unknown as Array<{ id: string; version_no: number; file_name: string; mime_type: string; size_bytes: number; uploaded_at: string; uploader: { full_name: string } | null }>)
      .map((v) => ({ id: v.id, versionNo: v.version_no, fileName: v.file_name, mimeType: v.mime_type, sizeBytes: v.size_bytes, uploadedAt: v.uploaded_at, uploadedBy: v.uploader?.full_name ?? "—" })),
    activity: ((activity.data ?? []) as unknown as Array<{ action: string; created_at: string; actor: { full_name: string } | null }>)
      .map((a) => ({ action: a.action, actor: a.actor?.full_name ?? "—", at: a.created_at })),
  };
}
