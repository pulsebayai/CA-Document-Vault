import Link from "next/link";
import { viewClient } from "@/lib/platform/queries";
import { Badge, Card } from "@/components/ui";
import { Back, Field, NoAccess, words } from "../../../../ui";

export const dynamic = "force-dynamic";

/** 19 (spec Y5): one client, read-only, PII in full. Another firm's client ID is Not Found (the database refuses it). */
export default async function PlatformClientPage({ params }: PageProps<"/platform/firms/[id]/clients/[clientId]">) {
  const { id, clientId } = await params;
  const r = await viewClient(id, clientId);
  if (!r.ok) return <NoAccess firmId={id} />;
  const c = r.data;
  const base = `/platform/firms/${id}`;
  return (
    <div>
      <Back href={`${base}/clients`}>Clients</Back>
      <h2 className="mb-4 text-lg font-semibold">{c.name} <span className="font-normal text-ink-3">{c.code}</span> {c.archived && <Badge tone="muted">Archived</Badge>}</h2>
      <Card className="mb-5 p-6">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Field label="Type">{words(c.client_type)}</Field>
          <Field label="PAN"><span className="font-mono">{c.pan ?? "—"}</span></Field>
          <Field label="Incharge">{c.incharge_name}</Field>
          <Field label="Email">{c.email}</Field>
          <Field label="Mobile">{c.mobile}</Field>
          <Field label="Previous reference">{c.previous_reference}</Field>
          <Field label="Registrations">
            {c.registrations.length ? c.registrations.map((g) => (
              <span key={`${g.kind}${g.number}`} className="block font-mono">{g.kind.toUpperCase()} {g.number}{!g.active && <span className="font-sans text-ink-3"> (inactive)</span>}</span>
            )) : "—"}
          </Field>
          <Field label="Groups">{c.groups.length ? c.groups.map((g) => `${g.name}${g.state !== "active" ? ` (${g.state})` : ""}`).join(", ") : "—"}</Field>
        </dl>
      </Card>
      <div className="flex flex-wrap gap-4 text-[13.5px]">
        <Link prefetch={false} className="font-medium text-accent underline-offset-2 hover:underline" href={`${base}/documents?client=${c.id}`}>Documents ({c.documents})</Link>
        <Link prefetch={false} className="font-medium text-accent underline-offset-2 hover:underline" href={`${base}/clients/${c.id}/expected`}>Expected documents ({c.expected_pending} pending)</Link>
      </div>
    </div>
  );
}
