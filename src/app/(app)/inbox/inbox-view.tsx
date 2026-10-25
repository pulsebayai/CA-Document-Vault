import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import type { InboxItem } from "@/lib/documents/queries";
import { CHANNEL_LABELS, RECEIVED_AS } from "@/lib/validation/document";

// Inbox (mockup 02, spec AC-7): documents that still need a client or a type, newest first.

const RECEIVED_LABEL = Object.fromEntries(RECEIVED_AS.map((r) => [r.value, r.label]));
const CHANNEL_LABEL = CHANNEL_LABELS; // 10: includes "Upload link"
const day = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** "waiting 3 h" / "waiting 2 days" (AC-7: how long it has waited). */
export function waited(createdAt: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 60_000));
  if (mins < 60) return `waiting ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `waiting ${hours} h`;
  return `waiting ${Math.floor(hours / 24)} days`;
}

export function InboxView({ items, now, saved }: { items: InboxItem[]; now: Date; saved?: string | null }) {
  return (
    <div className="mx-auto max-w-[815px]">
      <PageHeader title="Inbox" subtitle="Documents that still need a client or a type"
        actions={<Link href="/documents/new?from=/inbox" className="inline-flex items-center rounded-[9px] bg-accent px-3.5 py-2 font-medium text-white hover:bg-[#264d8f]">Add document</Link>} />
      {saved && <p role="status" className="mb-4 rounded-lg bg-ok-soft px-4 py-3 text-[13.5px] text-ok"><strong className="font-semibold">{saved}</strong> saved.</p>}
      {items.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="font-medium">Inbox is empty — everything received has a client and a type.</p>
        </Card>
      ) : (
        <Card>
          <ul aria-label="Inbox" className="divide-y divide-line">
            {items.map((d) => {
              const title = d.fileName ?? (d.receivedAs === "original" ? "Original" : "Hard copy");
              const missing = [!d.clientName && "No client", !d.typeName && "No type"].filter(Boolean).join(" · ");
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">{d.clientName ? `${d.clientName} · ` : ""}{title}</p>
                    <p className="mt-0.5 break-words text-[13.5px] text-ink-2">
                      {RECEIVED_LABEL[d.receivedAs]} · from {CHANNEL_LABEL[d.channel] ?? d.channel}
                      {d.remark && <> · remark: “{d.remark}”</>}
                      {" "}· added by {d.addedBy} {day.format(new Date(d.createdAt))}{" "}
                      <span className="text-ink-3">{d.docCode}</span>
                      {d.receivedAs !== "soft_copy" && <> <Badge tone={d.receivedAs === "original" ? "bad" : "warn"}>{RECEIVED_LABEL[d.receivedAs]}</Badge></>}
                    </p>
                  </div>
                  <span className="text-[13px] text-ink-3">{missing} · {waited(d.createdAt, now)}</span>
                  <Link href={`/documents/${d.id}/assign`} aria-label={`Assign ${d.docCode}`}
                    className="inline-flex h-[30px] items-center rounded-[7px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-[#264d8f]">Assign</Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
