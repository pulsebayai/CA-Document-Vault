"use client";

import { useId, useState, useTransition } from "react";
import { Button, Card } from "@/components/ui";
import { numCls } from "@/components/dialog";
import { setDscRemindDays } from "@/lib/dsc/actions";

// Feature 14 AC-10 — Client › Settings: "Remind N days before DSC expiry" (1–180, default 30). Staff+; Limited sees it.
export function DscRemindCard({ clientId, days, canEdit }: { clientId: string; days: number; canEdit: boolean }) {
  const uid = useId();
  const [value, setValue] = useState(String(days));
  const [saved, setSaved] = useState(days);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="p-5">
      <h2 className="font-semibold">DSC expiry reminders</h2>
      {canEdit ? (
        <form className="mt-2 space-y-2" onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await setDscRemindDays({ clientId, days: value });
            if (r.ok) { setSaved(r.days); setMsg({ ok: true, text: "Saved." }); } else setMsg({ ok: false, text: r.error });
          });
        }}>
          <label htmlFor={`${uid}-days`} className="block text-[13.5px] text-ink-2">Show on Today this many days before a DSC expires:</label>
          <div className="flex items-center gap-2">
            <input id={`${uid}-days`} type="number" min={1} max={180} required value={value} onChange={(e) => setValue(e.target.value)}
              className={numCls} aria-invalid={msg?.ok === false} aria-describedby={msg ? `${uid}-msg` : undefined} />
            <span className="text-[13.5px] text-ink-2">days</span>
            <Button type="submit" size="sm" variant="secondary" disabled={pending || value === String(saved)}>{pending ? "Saving…" : "Save"}</Button>
          </div>
          {msg && <p id={`${uid}-msg`} role={msg.ok ? "status" : "alert"} className={`text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
        </form>
      ) : (
        <p className="mt-2 text-[13.5px] text-ink-2">Shown on Today {days} days before a DSC expires.</p>
      )}
    </Card>
  );
}
