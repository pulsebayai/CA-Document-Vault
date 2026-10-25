import "server-only";
import { createClient } from "@/lib/supabase/server";
import { GST_STATES } from "@/lib/validation/gst-states";
import type { AdHocItem } from "@/lib/reminders/message";

// Feature 10 — staff-side reads for upload links (spec AC-1, AC-2). Runs as the signed-in user (RLS).

export type LinkTypeOption = {
  id: string; name: string; group: string; groupSort: number;
  periodKind: "month" | "quarter" | "year" | "none"; registrationKind: "gstin" | "tan" | null; proposed: boolean;
};
export type LinkPeriodOption = { id: string; kind: "month" | "quarter" | "year"; label: string; start: string };
export type LinkRegistrationOption = { id: string; kind: "gstin" | "tan"; label: string };
export type LinkOptions = {
  /** False when APP_PUBLIC_URL isn't set in this environment: links can't be sent. */
  enabled: boolean;
  /** The link's origin, for the preview only (the token is never in the preview). */
  base: string | null;
  types: LinkTypeOption[];
  periods: LinkPeriodOption[];
  registrations: LinkRegistrationOption[];
};

/**
 * The origin put in links: APP_PUBLIC_URL (required on staging/prod, R1 checklist), else on Vercel the deployment's
 * own address (production deployment of the dev project → its production URL; previews → the preview URL), so CI,
 * previews and the nightly regression work without extra settings.
 */
export function linkBase(): string | null {
  const vercel = process.env.VERCEL_ENV === "production" ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_URL;
  const v = process.env.APP_PUBLIC_URL?.trim() || (vercel ? `https://${vercel}` : "");
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.hostname === "localhost" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Types usable for an ad-hoc item: client-source, active, in an active group; approved, or proposed for this client. */
export async function linkOptionsAs(clientId: string): Promise<LinkOptions> {
  const supabase = await createClient();
  const [types, periods, regs] = await Promise.all([
    supabase.from("doc_type")
      .select("id, name, period_kind, registration_kind, status, proposed_for_client_id, source, doc_group:doc_group_id (name, sort, active)")
      .eq("active", true).eq("source", "client"),
    supabase.from("period").select("id, kind, label, start_date").order("start_date", { ascending: false }).limit(200),
    supabase.from("client_registration").select("id, kind, number, state_code").eq("client_id", clientId).eq("active", true),
  ]);
  const failed = [types, periods, regs].find((r) => r.error);
  if (failed) {
    console.error("upload_links.options_failed", { code: failed.error?.code });
    throw new Error("Could not load document types.");
  }
  type T = { id: string; name: string; period_kind: LinkTypeOption["periodKind"]; registration_kind: "gstin" | "tan" | null;
    status: string; proposed_for_client_id: string | null; doc_group: { name: string; sort: number; active: boolean } | null };
  const base = linkBase();
  return {
    enabled: base !== null,
    base,
    types: ((types.data ?? []) as unknown as T[])
      .filter((t) => t.doc_group?.active && (t.status === "approved" || (t.status === "proposed" && t.proposed_for_client_id === clientId)))
      .map((t) => ({ id: t.id, name: t.name, group: t.doc_group!.name, groupSort: t.doc_group!.sort, periodKind: t.period_kind,
        registrationKind: t.registration_kind, proposed: t.status === "proposed" }))
      .sort((a, b) => a.groupSort - b.groupSort || a.name.localeCompare(b.name)),
    periods: ((periods.data ?? []) as Array<{ id: string; kind: "month" | "quarter" | "year"; label: string; start_date: string }>)
      .map((p) => ({ id: p.id, kind: p.kind, label: p.label, start: p.start_date })),
    // Labels name the GST state or show the last 4 characters of a TAN — never the full number in the dialog.
    registrations: ((regs.data ?? []) as Array<{ id: string; kind: "gstin" | "tan"; number: string; state_code: string | null }>)
      .map((r) => ({ id: r.id, kind: r.kind, label: r.kind === "gstin"
        ? `${GST_STATES[r.state_code ?? r.number.slice(0, 2)] ?? "GST"} GSTIN` : `TAN ••${r.number.slice(-4)}` })),
  };
}

export type AdHocInput = { docTypeId: string; periodId: string | null; registrationId: string | null; neededBy: string | null; note: string | null };

/** Message lines for ad-hoc items, labelled from the database (never from the browser). Null if a type is unknown. */
export async function adHocLinesAs(items: AdHocInput[]): Promise<AdHocItem[] | null> {
  if (items.length === 0) return [];
  const supabase = await createClient();
  const typeIds = [...new Set(items.map((i) => i.docTypeId))];
  const periodIds = [...new Set(items.flatMap((i) => (i.periodId ? [i.periodId] : [])))];
  const [types, periods] = await Promise.all([
    supabase.from("doc_type").select("id, name, doc_group:doc_group_id (name)").in("id", typeIds),
    periodIds.length ? supabase.from("period").select("id, label").in("id", periodIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (types.error || periods.error) return null;
  const t = new Map(((types.data ?? []) as unknown as Array<{ id: string; name: string; doc_group: { name: string } }>).map((x) => [x.id, x]));
  const p = new Map(((periods.data ?? []) as Array<{ id: string; label: string }>).map((x) => [x.id, x.label]));
  if (items.some((i) => !t.has(i.docTypeId) || (i.periodId && !p.has(i.periodId)))) return null;
  return items.map((i) => ({
    group: t.get(i.docTypeId)!.doc_group.name, type: t.get(i.docTypeId)!.name,
    period: i.periodId ? p.get(i.periodId)! : null, neededBy: i.neededBy, note: i.note,
  }));
}

/** For Retry: the request's still-open items (scheduled: pending; ad-hoc: open). */
export async function retryContentAs(requestId: string): Promise<{
  clientId: string; scheduledIds: string[]; adHoc: AdHocInput[];
} | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("upload_request")
    .select("id, client_id, upload_request_item (kind, status, expected_doc_id, doc_type_id, period_id, registration_id, needed_by, note, expected:expected_doc_id (status))")
    .eq("id", requestId).maybeSingle();
  if (error || !data) return null;
  type I = { kind: "scheduled" | "ad_hoc"; status: string; expected_doc_id: string | null; doc_type_id: string | null; period_id: string | null;
    registration_id: string | null; needed_by: string | null; note: string | null; expected: { status: string } | null };
  const items = (data as unknown as { client_id: string; upload_request_item: I[] }).upload_request_item;
  return {
    clientId: (data as { client_id: string }).client_id,
    scheduledIds: items.filter((i) => i.kind === "scheduled" && i.expected?.status === "pending").map((i) => i.expected_doc_id!),
    adHoc: items.filter((i) => i.kind === "ad_hoc" && i.status === "open").map((i) => ({
      docTypeId: i.doc_type_id!, periodId: i.period_id, registrationId: i.registration_id, neededBy: i.needed_by, note: i.note })),
  };
}
