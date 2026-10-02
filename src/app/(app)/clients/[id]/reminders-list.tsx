import { Card } from "@/components/ui";
import { shortDate } from "@/lib/expected/schedule";
import type { ReminderListEntry } from "@/lib/reminders/queries";

// Feature 06 AC-12 — the client's Reminders list under the Expected tab: newest first, date, channel, who, items,
// status and call note. The address is shown masked ("a…@…"); the full one stays on the follow-up row.

const CHANNEL = { email: "Email", whatsapp: "WhatsApp", phone: "Call" } as const;
const STATUS: Record<ReminderListEntry["status"], string> = {
  pending: "Sending…", sent: "Sent", failed: "Failed", suppressed: "Not sent (test address)", opened: "Opened in WhatsApp", logged: "Logged",
};

export function RemindersList({ entries, today }: { entries: ReminderListEntry[]; today: string }) {
  return (
    <Card>
      <section aria-labelledby="reminders-h">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 id="reminders-h" className="font-semibold">Reminders</h3>
          <span className="text-[13px] text-ink-3">{entries.length === 0 ? "None yet" : `${entries.length} most recent`}</span>
        </header>
        {entries.length === 0 ? (
          <p className="px-5 py-4 text-[13.5px] text-ink-2">No reminders yet. Use Remind or Log call on an open document.</p>
        ) : (
          <ul aria-label="Reminders, newest first" className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="px-5 py-3">
                <p className="break-words">
                  <span className="font-medium">{shortDate(e.on, today)}</span>{` · ${CHANNEL[e.channel]} · `}
                  <span className="text-ink-3">{e.by}</span>{" · "}
                  <span className={e.status === "failed" ? "text-bad" : "text-ink-2"}>{STATUS[e.status]}{e.recipientMasked ? ` to ${e.recipientMasked}` : ""}</span>
                </p>
                <p className="mt-0.5 break-words text-[13px] text-ink-3">{e.items.join(" · ")}</p>
                {e.note && <p className="mt-1 break-words text-[13px]">“{e.note}”</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}
