"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import type { ClientFormState } from "@/lib/clients/actions";
import type { ClientDetail, GroupOption, StaffOption } from "@/lib/clients/queries";
import { CLIENT_TYPES, CLIENT_TYPE_LABEL } from "@/lib/validation/client";
import { gstinState, normaliseIdentifier } from "@/lib/validation/identifiers";
import { Button, Card } from "@/components/ui";

type Props = {
  action: (prev: ClientFormState, fd: FormData) => Promise<ClientFormState>;
  staff: StaffOption[];
  /** Create only: groups to enable, pre-ticked from "Enabled for new clients" (AC-8). */
  groups?: GroupOption[];
  client?: ClientDetail;
  defaultInchargeId: string;
  /** AC-10: only Admin/Manager change incharge on an existing client. */
  canChangeIncharge: boolean;
  cancelHref: string;
};

type Reg = { key: number; kind: "gstin" | "tan"; number: string };

const input = "mt-1 w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad disabled:bg-canvas disabled:text-ink-2";

/** Add client / Edit client (spec AC-8 … AC-10). Controlled fields, so a refused save never clears what was typed. */
export function ClientForm({ action, staff, groups, client, defaultInchargeId, canChangeIncharge, cancelHref }: Props) {
  const [state, act, pending] = useActionState<ClientFormState, FormData>(action, null);
  const uid = useId();
  const [v, setV] = useState({
    name: client?.name ?? "", clientType: client?.clientType ?? "", pan: client?.pan ?? "",
    previousReference: client?.previousReference ?? "", email: client?.email ?? "", mobile: client?.mobile ?? "",
    inchargeId: client?.inchargeId ?? defaultInchargeId,
  });
  const [regs, setRegs] = useState<Reg[]>(() => {
    const list = (client?.registrations ?? []).map((r, i) => ({ key: i, kind: r.kind, number: r.number }));
    return list.length ? list : [{ key: 0, kind: "gstin", number: "" }];
  });
  const [picked, setPicked] = useState<Set<string>>(() => new Set((groups ?? []).filter((g) => g.enabledForNewClients).map((g) => g.id)));

  const fe = state?.fieldErrors ?? {};
  const warn = state?.warnings ?? {};
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const a11y = (f: string) => ({
    "aria-invalid": !!fe[f],
    "aria-describedby": [fe[f] && `${uid}-${f}-err`, warn[f] && `${uid}-${f}-warn`].filter(Boolean).join(" ") || undefined,
  });
  const msg = (f: string) => (
    <>
      {fe[f] && <p id={`${uid}-${f}-err`} className="mt-1 text-[13px] text-bad">{fe[f]}</p>}
      {warn[f] && <p id={`${uid}-${f}-warn`} className="mt-1 text-[13px] text-warn">{warn[f]}</p>}
    </>
  );
  const inchargeLocked = !!client && !canChangeIncharge;

  return (
    <form action={act} noValidate className="max-w-[760px] space-y-5">
      {client && <input type="hidden" name="id" value={client.id} />}
      {state && (
        <p role="alert" className={`rounded-lg px-4 py-3 text-[13.5px] ${state.needsConfirm ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}>{state.error}</p>
      )}

      <Card className="space-y-4 p-6">
        <h2 className="font-semibold">Client details</h2>
        <div>
          <label className="block text-[13.5px] font-medium">Name <span aria-hidden className="text-bad">*</span>
            <input name="name" value={v.name} onChange={set("name")} required maxLength={200} autoComplete="off" className={input} {...a11y("name")} />
          </label>
          {msg("name")}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-[13.5px] font-medium">Client type <span aria-hidden className="text-bad">*</span>
              <select name="clientType" value={v.clientType} onChange={set("clientType")} required className={input} {...a11y("clientType")}>
                <option value="">Choose…</option>
                {CLIENT_TYPES.map((t) => <option key={t} value={t}>{CLIENT_TYPE_LABEL[t]}</option>)}
              </select>
            </label>
            {msg("clientType")}
          </div>
          <div>
            <label className="block text-[13.5px] font-medium">PAN <span className="font-normal text-ink-3">(optional)</span>
              <input name="pan" value={v.pan} onChange={set("pan")} maxLength={12} autoComplete="off" spellCheck={false}
                placeholder="AAAAA9999A" className={`${input} uppercase`} {...a11y("pan")} />
            </label>
            {msg("pan")}
          </div>
          <div>
            <label className="block text-[13.5px] font-medium">Previous reference <span className="font-normal text-ink-3">(optional)</span>
              <input name="previousReference" value={v.previousReference} onChange={set("previousReference")} maxLength={60} autoComplete="off" className={input} {...a11y("previousReference")} />
            </label>
            {msg("previousReference")}
          </div>
          <div>
            <label className="block text-[13.5px] font-medium">Incharge <span aria-hidden className="text-bad">*</span>
              <select name={inchargeLocked ? undefined : "inchargeId"} value={v.inchargeId} onChange={set("inchargeId")} disabled={inchargeLocked} required className={input} {...a11y("inchargeId")}>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            {inchargeLocked && <input type="hidden" name="inchargeId" value={v.inchargeId} />}
            {inchargeLocked && <p className="mt-1 text-[13px] text-ink-3">Only an Admin or Manager can change the incharge.</p>}
            {msg("inchargeId")}
          </div>
          <div>
            <label className="block text-[13.5px] font-medium">Email <span className="font-normal text-ink-3">(optional)</span>
              <input name="email" type="email" value={v.email} onChange={set("email")} autoComplete="off" className={input} {...a11y("email")} />
            </label>
            {msg("email")}
          </div>
          <div>
            <label className="block text-[13.5px] font-medium">Mobile <span className="font-normal text-ink-3">(optional)</span>
              <input name="mobile" type="tel" inputMode="tel" value={v.mobile} onChange={set("mobile")} autoComplete="off" placeholder="10-digit mobile" className={input} {...a11y("mobile")} />
            </label>
            {msg("mobile")}
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <fieldset aria-describedby={fe.registrations ? `${uid}-registrations-err` : undefined}>
          <legend className="font-semibold">Registrations</legend>
          <p className="mt-0.5 text-[13px] text-ink-3">GSTINs and TANs. A GSTIN must contain the client&apos;s PAN; its state is read from the first two digits.</p>
          <div className="mt-3 space-y-2">
            {regs.map((r, i) => {
              const n = normaliseIdentifier(r.number);
              const state = r.kind === "gstin" && n.length === 15 ? gstinState(n) : null;
              return (
                <div key={r.key} className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`${uid}-kind-${r.key}`}>Registration {i + 1} type</label>
                  <select id={`${uid}-kind-${r.key}`} name="regKind" value={r.kind}
                    onChange={(e) => setRegs((all) => all.map((x) => x.key === r.key ? { ...x, kind: e.target.value as Reg["kind"] } : x))}
                    className="h-10 rounded-[9px] border border-line-2 bg-panel px-2">
                    <option value="gstin">GSTIN</option>
                    <option value="tan">TAN</option>
                  </select>
                  <label className="sr-only" htmlFor={`${uid}-num-${r.key}`}>Registration {i + 1} number</label>
                  <input id={`${uid}-num-${r.key}`} name="regNumber" value={r.number} autoComplete="off" spellCheck={false} maxLength={20}
                    onChange={(e) => setRegs((all) => all.map((x) => x.key === r.key ? { ...x, number: e.target.value } : x))}
                    className="h-10 w-56 rounded-[9px] border border-line-2 bg-panel px-3 uppercase outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
                  {state && <span className="text-[13px] text-ink-2">{state.name}</span>}
                  <Button type="button" size="sm" variant="secondary" aria-label={`Remove registration ${i + 1}`}
                    onClick={() => setRegs((all) => all.length > 1 ? all.filter((x) => x.key !== r.key) : [{ key: r.key + 1, kind: "gstin", number: "" }])}>Remove</Button>
                </div>
              );
            })}
          </div>
          <button type="button" className="mt-2 text-[13.5px] font-medium text-accent hover:underline"
            onClick={() => setRegs((all) => [...all, { key: Math.max(...all.map((x) => x.key)) + 1, kind: "gstin", number: "" }])}>
            + Add GSTIN or TAN
          </button>
          {fe.registrations && <p id={`${uid}-registrations-err`} className="mt-1 text-[13px] text-bad">{fe.registrations}</p>}
        </fieldset>
      </Card>

      {groups && (
        <Card className="p-6">
          <fieldset>
            <legend className="font-semibold">Document groups to collect</legend>
            <p className="mt-0.5 text-[13px] text-ink-3">Each ticked group adds its document types to this client&apos;s collection plan. You can change this later.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-[14px]">
                  <input type="checkbox" name="groupIds" value={g.id} checked={picked.has(g.id)} className="h-4 w-4 accent-accent"
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(g.id); else n.delete(g.id); return n; })} />
                  {g.name}
                </label>
              ))}
            </div>
          </fieldset>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href={cancelHref} className="rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Cancel</Link>
        {state?.needsConfirm ? (
          <Button type="submit" name="confirmWarnings" value="1" disabled={pending}>{pending ? "Saving…" : "Save anyway"}</Button>
        ) : (
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : client ? "Save changes" : "Add client"}</Button>
        )}
      </div>
    </form>
  );
}
