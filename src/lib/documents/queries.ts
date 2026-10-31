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
  /** 11 (spec AC-19, AC-20): the type's preferred formats; the client's exception; the plan row (any state) for it. */
  preferredFormats?: string[] | null;
  anyFormat?: boolean;
  planRowId?: string | null;
  /** 12 (spec AC-2): old/new form names, and the group's catalogue order, for the type-ahead field. */
  aliases?: string[]; groupSort?: number;
};
export type RegistrationOption = { id: string; kind: "gstin" | "tan"; number: string };
export type PeriodOption = { id: string; kind: Exclude<PeriodKind, "none">; code: string; label: string; fyCode: string };
export type ClientTypes = { planTypes: TypeOption[]; otherTypes: TypeOption[]; registrations: RegistrationOption[] };
export type ClientOption = { id: string; name: string; code: string };

type TypeRow = {
  id: string; name: string; doc_group_id: string; period_kind: PeriodKind; default_frequency: Frequency;
  registration_kind: "gstin" | "tan" | null; status: "approved" | "proposed"; proposed_for_client_id: string | null;
  preferred_formats: string[] | null; aliases: string[] | null;
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
      .select("id, name, doc_group_id, period_kind, default_frequency, registration_kind, status, proposed_for_client_id, preferred_formats, aliases, doc_group:doc_group_id (name, sort, active)")
      .eq("active", true),
    clientId
      // 11: every plan row (any state) — the exception lives on the row whatever its state; "in plan" = active rows.
      ? supabase.from("client_doc_type").select("id, doc_type_id, frequency, state, any_format").eq("client_id", clientId)
      : Promise.resolve({ data: [] as { id: string; doc_type_id: string; frequency: Frequency; state: string; any_format: boolean }[], error: null }),
    clientId
      ? supabase.from("client_registration").select("id, kind, number").eq("client_id", clientId).eq("active", true).order("number")
      : Promise.resolve({ data: [] as RegistrationOption[], error: null }),
  ]);
  const failed = [types, plan, regs].find((r) => r.error);
  if (failed) {
    console.error("documents.types_failed", { code: failed.error?.code });
    throw new Error("Could not load document types.");
  }
  const rows = (plan.data ?? []) as { id: string; doc_type_id: string; frequency: Frequency; state: string; any_format: boolean }[];
  const inPlan = new Map(rows.filter((p) => p.state === "active").map((p) => [p.doc_type_id, p.frequency]));
  const rowOf = new Map(rows.map((p) => [p.doc_type_id, p]));
  const all = ((types.data ?? []) as unknown as TypeRow[])
    .filter((t) => t.doc_group?.active)
    .filter((t) => t.status === "approved" || (clientId && t.proposed_for_client_id === clientId))
    .map((t) => ({
      id: t.id, name: t.name, groupId: t.doc_group_id, groupName: t.doc_group!.name, sort: t.doc_group!.sort,
      periodKind: t.period_kind, frequency: inPlan.get(t.id) ?? t.default_frequency,
      registrationKind: t.registration_kind, proposed: t.status === "proposed",
      preferredFormats: t.preferred_formats ?? null, anyFormat: rowOf.get(t.id)?.any_format ?? false,
      planRowId: rowOf.get(t.id)?.id ?? null, aliases: t.aliases ?? [],
    }))
    .sort(byGroupThenName);
  const strip = (t: TypeOption & { sort: number }): TypeOption => ({
    id: t.id, name: t.name, groupId: t.groupId, groupName: t.groupName, periodKind: t.periodKind,
    frequency: t.frequency, registrationKind: t.registrationKind, proposed: t.proposed,
    preferredFormats: t.preferredFormats, anyFormat: t.anyFormat, planRowId: t.planRowId,
    aliases: t.aliases, groupSort: t.sort, // 12
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
  /** 12: the client wants this hard copy back. */
  returnable?: boolean; handedOverName?: string | null;
  /** 12 (AC-18): the current file for View / Download (null = no file yet). */
  file?: CurrentFile | null;
  channel: string; remark: string | null; addedBy: string; createdAt: string;
  clientName: string | null; typeName: string | null;
};

type InboxRow = {
  id: string; doc_code: string; received_as: InboxItem["receivedAs"]; returnable: boolean; handed_over_name: string | null; channel: string; remark: string | null; created_at: string; status: string;
  creator: { full_name: string } | null; current: { id: string; file_name: string; mime_type: string } | null;
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
    throw new Error("Could not load untagged documents.");
  }
  return ((data ?? []) as unknown as InboxRow[]).map((r) => ({
    id: r.id, docCode: r.doc_code, fileName: r.current?.file_name ?? null, receivedAs: r.received_as, returnable: r.returnable, handedOverName: r.handed_over_name, channel: r.channel,
    file: r.current ? { versionId: r.current.id, mimeType: r.current.mime_type, viewBlocked: r.channel === "upload_link" && r.status !== "reviewed" } : null,
    remark: r.remark, addedBy: r.creator?.full_name ?? "—", createdAt: r.created_at,
    clientName: r.client?.name ?? null, typeName: r.doc_type?.name ?? null,
  }));
}

/** 12 (AC-17): filed documents waiting for review (Today › To review, everyone), for the Untagged page's subtitle. */
export async function toReviewCount(): Promise<number> {
  const supabase = await createClient();
  // Review N-8: like today_items, documents of archived clients don't count.
  const { count } = await supabase.from("document").select("id, client!inner(archived_at)", { count: "exact", head: true })
    .not("classified_at", "is", null).is("archived_at", null).eq("status", "received").is("client.archived_at", null);
  return count ?? 0;
}

// ── 12 (AC-18): View / Download on list rows ───────────────────────────────
/** A row's current file, for 03's FileButtons. `viewBlocked`: a client-link file not yet reviewed (10, D3). */
export type CurrentFile = { versionId: string; mimeType: string; viewBlocked: boolean };

/**
 * Current files of the given documents, read as the signed-in user (RLS), in batches of 100 (URL length).
 * Best effort, like Today's Upload links: a failed batch only loses those rows' buttons, and is logged (code only).
 * A document with no file maps to null; one that couldn't be read is absent (so no "No file yet" on a failure).
 */
export async function currentFiles(ids: string[]): Promise<Map<string, CurrentFile | null>> {
  const out = new Map<string, CurrentFile | null>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const { data, error } = await supabase.from("document")
        .select("id, channel, status, current:current_version_id (id, mime_type)").in("id", ids.slice(i, i + 100));
      if (error) { console.error("documents.current_files_failed", { code: error.code ?? "unknown" }); continue; }
      for (const r of (data ?? []) as unknown as Array<{ id: string; channel: string; status: string; current: { id: string; mime_type: string } | null }>) {
        out.set(r.id, r.current
          ? { versionId: r.current.id, mimeType: r.current.mime_type, viewBlocked: r.channel === "upload_link" && r.status !== "reviewed" }
          : null);
      }
    } catch {
      console.error("documents.current_files_failed", { code: "exception" });
    }
  }
  return out;
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
  /** 12: returnable hard copy; who handed it in (personal data: shown on the document, never logged). */
  returnable?: boolean; handedOverName?: string | null;
  /** 12 (AC-20): review status, so the form can say a change resets the review. */
  status?: string;
  remark: string | null; fileName: string | null; versionCount: number; classified: boolean; archived: boolean;
};

export async function getDocumentForForm(id: string): Promise<DocumentForForm | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("document")
    .select(`id, doc_code, doc_type_id, period_id, registration_id, received_as, returnable, handed_over_name, status, channel, received_on, remark, version_count,
      classified_at, archived_at, client:client_id (id, name, code), current:current_version_id (file_name)`)
    .eq("id", id).maybeSingle();
  if (!data) return null;
  const client = data.client as unknown as ClientOption | null;
  return {
    id: data.id, docCode: data.doc_code, client: client ? { id: client.id, name: client.name, code: client.code } : null,
    docTypeId: data.doc_type_id, periodId: data.period_id, registrationId: data.registration_id,
    receivedAs: data.received_as, channel: data.channel, receivedOn: data.received_on, remark: data.remark,
    returnable: !!data.returnable, handedOverName: data.handed_over_name ?? null, status: data.status,
    fileName: (data.current as unknown as { file_name: string } | null)?.file_name ?? null,
    versionCount: data.version_count, classified: !!data.classified_at, archived: !!data.archived_at,
  };
}

// ── Client › Documents (AC-10) ───────────────────────────────────────────────
export type ClientDocument = {
  id: string; docCode: string; typeName: string; groupId: string; groupName: string; groupSort: number;
  periodLabel: string | null; periodStart: string | null; fyCode: string; receivedOn: string; receivedBy: string;
  receivedAs: "soft_copy" | "hard_copy" | "original"; versionCount: number;
  /** 12 */
  returnable?: boolean; correctionKind?: string | null;
  current: { id: string; mimeType: string } | null; proposed: boolean;
  /** 10: the document came through a client upload link ("From client link"). */
  fromLink?: boolean;
  /** 11 (spec AC-16): filed outside the preference that applied — the snapshot it missed. */
  notPreferred?: string[] | null;
  // 07: review state and the live packet (documentState() in ./state.ts).
  status: string; reviewedAt: string | null; reviewedByName: string | null; correctionReason: string | null;
  dispatchedOn: string | null; dispatchMethod: string | null;
  /** 13: the stored custody step and when it was marked in office. */
  custody?: "in_office" | "ready" | null; inOfficeAt?: string | null;
};

type ClientDocRow = {
  id: string; doc_code: string; received_on: string; received_as: ClientDocument["receivedAs"]; returnable: boolean; version_count: number;
  channel: string;
  receiver: { full_name: string } | null;
  doc_type: { name: string; status: string; doc_group: { id: string; name: string; sort: number } | null } | null;
  period: { label: string; start_date: string; financial_year: { code: string } | null } | null;
  current: { id: string; mime_type: string } | null;
  status: string; reviewed_at: string | null; correction_reason: string | null; correction_kind: string | null; reviewer: { full_name: string } | null;
  packets: Array<{ removed_at: string | null; dispatch: { dispatched_on: string; method: string } | null }> | null;
  format_ok: boolean | null; format_preferred: string[] | null;
  custody: "in_office" | "ready" | null; in_office_at: string | null; // 13
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
    receivedOn: r.received_on, receivedBy: r.receiver?.full_name ?? "—", receivedAs: r.received_as, returnable: r.returnable,
    correctionKind: r.correction_kind, versionCount: r.version_count, current: r.current ? { id: r.current.id, mimeType: r.current.mime_type } : null,
    proposed: r.doc_type!.status === "proposed", fromLink: r.channel === "upload_link",
    notPreferred: r.format_ok === false ? r.format_preferred : null,
    custody: r.custody, inOfficeAt: r.in_office_at, // 13
    ...reviewFields(r),
  }));
}

/** 07: the review columns + the live packet (at most one: unique index on live items). */
function reviewFields(r: ClientDocRow) {
  const live = (r.packets ?? []).find((p) => p.removed_at === null)?.dispatch ?? null;
  return {
    status: r.status, reviewedAt: r.reviewed_at, reviewedByName: r.reviewer?.full_name ?? null, correctionReason: r.correction_reason,
    dispatchedOn: live?.dispatched_on ?? null, dispatchMethod: live?.method ?? null,
  };
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
  /** 11 (spec AC-16): the preference the current file missed, or null. */
  notPreferred?: string[] | null;
  /** 11 (spec AC-19): the preference that applies to a new version now (type's list unless the client has an exception). */
  appliedFormats?: string[] | null;
  // 07: review state (the history and packets load separately: src/lib/review, src/lib/dispatch).
  status: string; reviewedAt: string | null; reviewedByName: string | null; correctionReason: string | null;
  /** 12: Wrong file / Wrong details (null on older corrections). */
  correctionKind: string | null;
  /** 13: custody step with who/when (who = null for steps set when custody started). */
  custody: { step: "in_office" | "ready" | null; inOfficeAt: string | null; inOfficeBy: string | null; readyAt: string | null; readyBy: string | null };
  versions: { id: string; versionNo: number; fileName: string; mimeType: string; sizeBytes: number; uploadedAt: string; uploadedBy: string }[];
};

export async function getDocumentDetail(id: string): Promise<DocumentDetail | null> {
  const base = await getDocumentForForm(id);
  if (!base) return null;
  const supabase = await createClient();
  const [doc, versions] = await Promise.all([
    supabase.from("document").select(`created_at, archived_at, archive_reason, current_version_id, format_ok, format_preferred,
        status, reviewed_at, correction_reason, correction_kind, reviewer:reviewed_by (full_name),
        custody, in_office_at, ready_at, in_office_person:in_office_by (full_name), ready_person:ready_by (full_name),
        receiver:received_by (full_name), creator:created_by (full_name),
        doc_type:doc_type_id (name, preferred_formats, doc_group:doc_group_id (name)), period:period_id (label), registration:registration_id (number)`)
      .eq("id", id).single(),
    supabase.from("document_version").select("id, version_no, file_name, mime_type, size_bytes, uploaded_at, uploader:uploaded_by (full_name)")
      .eq("document_id", id).order("version_no", { ascending: false }),
  ]); // 08: the Activity card reads activity_feed (documents/[id]/activity-card.tsx)
  if (doc.error || versions.error) throw new Error("Could not load the document.");
  const d = doc.data as unknown as {
    created_at: string; archived_at: string | null; archive_reason: string | null; current_version_id: string | null;
    format_ok: boolean | null; format_preferred: string[] | null;
    status: string; reviewed_at: string | null; correction_reason: string | null; correction_kind: string | null; reviewer: { full_name: string } | null;
    custody: "in_office" | "ready" | null; in_office_at: string | null; ready_at: string | null; // 13
    in_office_person: { full_name: string } | null; ready_person: { full_name: string } | null;
    receiver: { full_name: string } | null; creator: { full_name: string } | null;
    doc_type: { name: string; preferred_formats: string[] | null; doc_group: { name: string } | null } | null; period: { label: string } | null;
    registration: { number: string } | null;
  };
  let appliedFormats: string[] | null = d.doc_type?.preferred_formats ?? null;
  if (appliedFormats && base.client && base.docTypeId) {
    const { data: row } = await supabase.from("client_doc_type").select("any_format")
      .eq("client_id", base.client.id).eq("doc_type_id", base.docTypeId).maybeSingle();
    if (row?.any_format) appliedFormats = null;
  }
  return {
    ...base,
    appliedFormats,
    typeName: d.doc_type?.name ?? null, groupName: d.doc_type?.doc_group?.name ?? null, periodLabel: d.period?.label ?? null,
    registrationNumber: d.registration?.number ?? null, receivedBy: d.receiver?.full_name ?? "—", addedBy: d.creator?.full_name ?? "—",
    createdAt: d.created_at, archivedAt: d.archived_at, archiveReason: d.archive_reason, currentVersionId: d.current_version_id,
    notPreferred: d.format_ok === false ? d.format_preferred : null,
    status: d.status, reviewedAt: d.reviewed_at, reviewedByName: d.reviewer?.full_name ?? null, correctionReason: d.correction_reason,
    correctionKind: d.correction_kind,
    custody: { step: d.custody, inOfficeAt: d.in_office_at, inOfficeBy: d.in_office_person?.full_name ?? null,
      readyAt: d.ready_at, readyBy: d.ready_person?.full_name ?? null }, // 13
    versions: ((versions.data ?? []) as unknown as Array<{ id: string; version_no: number; file_name: string; mime_type: string; size_bytes: number; uploaded_at: string; uploader: { full_name: string } | null }>)
      .map((v) => ({ id: v.id, versionNo: v.version_no, fileName: v.file_name, mimeType: v.mime_type, sizeBytes: v.size_bytes, uploadedAt: v.uploaded_at, uploadedBy: v.uploader?.full_name ?? "—" })),
  };
}
