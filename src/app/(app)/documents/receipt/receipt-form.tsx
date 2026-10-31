"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import { searchClients } from "@/lib/clients/actions";
import { loadClientTypes } from "@/lib/documents/actions";
import { allowedPeriodKinds, defaultPeriod } from "@/lib/documents/period";
import type { ClientOption, ClientTypes, PeriodOption } from "@/lib/documents/queries";
import { CHANNELS, type Channel } from "@/lib/validation/document";
import { logReceipt, type LogReceiptResult } from "@/lib/receipt/actions";
import { MAX_RECEIPT_COUNT, paperReference } from "@/lib/receipt/validation";
import { Button, Card } from "@/components/ui";
import { TypeCombobox, type ComboType } from "@/components/type-combobox";

// Feature 13 (spec AC-13 … AC-16; Q1, Q2, Q3) — Log receipt for the reception desk (Staff role, no new permission):
// client, what came in (optional type), how many, who handed it over. It creates one hard copy per paper with no file;
// the confirmation lists each paper's reference (client code + DOC-ID) to write on it, and the scan is attached later.

const control = "w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad";
const KIND_LABEL = { month: "Month", quarter: "Quarter", year: "Year" } as const;
const EMPTY_TYPES: ClientTypes = { planTypes: [], otherTypes: [], registrations: [] };

type Done = Extract<LogReceiptResult, { ok: true }>;

export function ReceiptForm({ initialClient, initialTypes, periods, today }: {
  initialClient: ClientOption | null; initialTypes: ClientTypes; periods: PeriodOption[]; today: string;
}) {
  const uid = useId();
  const [client, setClient] = useState<ClientOption | null>(initialClient);
  const [types, setTypes] = useState<ClientTypes>(initialClient ? initialTypes : EMPTY_TYPES);
  const [typesLoading, setTypesLoading] = useState(false);
  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<ClientOption[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientRun = useRef(0); // the latest client pick wins (a slower earlier load is ignored)
  const [docTypeId, setDocTypeId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [count, setCount] = useState("1");
  const [handedOverName, setHandedOverName] = useState("");
  const [returnable, setReturnable] = useState(false);
  const [receivedOn, setReceivedOn] = useState(today);
  const [channel, setChannel] = useState<Channel>("hand_delivery");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Done | null>(null);

  const allTypes = useMemo(() => [...types.planTypes, ...types.otherTypes], [types]);
  const comboTypes: ComboType[] = useMemo(() => {
    const inPlan = new Set(types.planTypes.map((t) => t.id));
    return allTypes.filter((t) => !t.proposed || inPlan.has(t.id)).map((t) => ({
      id: t.id, name: t.name, groupId: t.groupId, groupName: t.groupName, groupSort: t.groupSort ?? 0, frequency: t.frequency,
      inPlan: inPlan.has(t.id), proposed: t.proposed, aliases: t.aliases ?? [],
    }));
  }, [allTypes, types.planTypes]);
  const type = allTypes.find((t) => t.id === docTypeId);
  const kinds = type ? allowedPeriodKinds(type.periodKind) : [];

  function onClientQuery(q: string) {
    setClientQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.trim().length < 2) { setClientResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      const r = await searchClients({ query: q });
      setClientResults(r.ok ? r.rows.slice(0, 8).map((c) => ({ id: c.id, name: c.name, code: c.code })) : []);
    }, 250);
  }

  async function pickClient(c: ClientOption | null) {
    const run = ++clientRun.current;
    setClient(c); setClientQuery(""); setClientResults([]); setDocTypeId(""); setPeriodId("");
    setTypes(EMPTY_TYPES);
    if (!c) return;
    setTypesLoading(true);
    const r = await loadClientTypes(c.id);
    if (run !== clientRun.current) return;
    setTypesLoading(false);
    if (!r.ok) { setError(r.error); return; }
    setTypes({ planTypes: r.planTypes, otherTypes: r.otherTypes, registrations: r.registrations });
  }

  function onType(id: string) {
    setDocTypeId(id);
    const t = allTypes.find((x) => x.id === id);
    const d = t ? defaultPeriod(t.frequency, today) : null;
    setPeriodId(d ? periods.find((p) => p.kind === d.kind && p.code === d.code)?.id ?? "" : "");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(""); setFieldErrors({});
    const r = await logReceipt({ clientId: client?.id ?? "", docTypeId, periodId, count, handedOverName, returnable, receivedOn, channel, remark })
      .catch(() => ({ ok: false as const, error: "Couldn't reach the server. Please try again.", fieldErrors: {} }));
    setSaving(false);
    if (!r.ok) { setError(r.error); setFieldErrors(r.fieldErrors); return; }
    setDone(r);
  }

  /** The next paper usually comes from the same client (pre-PR review nit 8): keep the client, clear the rest. */
  function another() {
    setDone(null); setDocTypeId(""); setPeriodId(""); setCount("1"); setHandedOverName(""); setReturnable(false);
    setReceivedOn(today); setChannel("hand_delivery"); setRemark("");
  }

  const fe = (f: string) => fieldErrors[f];
  const err = (f: string) => (fe(f) ? <p id={`${uid}-${f}-err`} className="mt-1 text-[13px] text-bad">{fe(f)}</p> : null);
  const described = (f: string, hint?: string) => ({
    "aria-invalid": fe(f) ? true : undefined,
    "aria-describedby": [fe(f) && `${uid}-${f}-err`, hint].filter(Boolean).join(" ") || undefined,
  });

  if (done) {
    const n = done.documents.length;
    return (
      <Card className="p-5">
        <h2 role="status" className="font-semibold">Logged {n} {n === 1 ? "paper" : "papers"} for {client?.name}</h2>
        <p className="mt-1 text-[13.5px] text-ink-2">Write each reference on its paper. Attach the scan later from the document (or from Untagged documents).</p>
        <ul aria-label="Paper references" className="mt-3 divide-y divide-line rounded-lg border border-line">
          {done.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <span className="font-mono text-[14px]">{paperReference(done.clientCode, d.docCode)}</span>
              <Link href={`/documents/${d.id}#current-file`} className="text-[13.5px] font-medium text-accent underline">Attach scan<span className="sr-only"> for {d.docCode}</span></Link>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={another}>Log another receipt</Button>
          {client && <Link href={`/clients/${client.id}`} className="inline-flex items-center rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Open {client.name}</Link>}
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <Card className="divide-y divide-line">
        <Row label="Client" htmlFor={`${uid}-client`}>
          {client ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{client.name}</span>
              <span className="text-[13px] text-ink-3">{client.code}</span>
              <button type="button" onClick={() => void pickClient(null)} className="text-[13px] text-accent hover:underline">Change</button>
            </div>
          ) : (
            <div className="relative">
              <input id={`${uid}-client`} type="search" role="combobox" autoComplete="off" value={clientQuery}
                aria-expanded={clientResults.length > 0} aria-controls={`${uid}-client-list`} aria-autocomplete="list"
                placeholder="Search by name, code or PAN" onChange={(e) => onClientQuery(e.target.value)} className={control} {...described("clientId")} />
              {clientResults.length > 0 && (
                <ul id={`${uid}-client-list`} role="listbox" aria-label="Matching clients" className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-panel shadow-card">
                  {clientResults.map((c) => (
                    <li key={c.id} role="option" aria-selected="false">
                      <button type="button" onClick={() => void pickClient(c)} className="flex w-full justify-between gap-3 px-3 py-2 text-left hover:bg-canvas">
                        <span>{c.name}</span><span className="text-[13px] text-ink-3">{c.code}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {err("clientId")}
        </Row>

        <Row label="What came in" htmlFor={`${uid}-type`}>
          <TypeCombobox id={`${uid}-type`} types={comboTypes} value={docTypeId} onChange={onType} disabled={!client || typesLoading}
            invalid={!!fe("docTypeId")} describedBy={[fe("docTypeId") && `${uid}-docTypeId-err`, `${uid}-type-hint`].filter(Boolean).join(" ")}
            canPropose={false} onPropose={() => undefined} />
          {err("docTypeId")}
          <p id={`${uid}-type-hint`} className="mt-1 text-[13px] text-ink-3">
            {typesLoading ? "Loading types…" : type ? <>Filed as {type.groupName} › {type.name}. <button type="button" className="text-accent hover:underline" onClick={() => onType("")}>Clear</button></>
              : "Optional. Leave it blank and the papers go to Untagged documents for this client."}
          </p>
        </Row>

        {type && (
          <Row label="Period" htmlFor={`${uid}-period`}>
            <select id={`${uid}-period`} value={periodId} onChange={(e) => setPeriodId(e.target.value)} className={`${control} w-auto min-w-48`} {...described("periodId")}>
              <option value="">No period</option>
              {kinds.map((k) => (
                <optgroup key={k} label={KIND_LABEL[k]}>
                  {periods.filter((p) => p.kind === k).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </optgroup>
              ))}
            </select>
            {err("periodId")}
          </Row>
        )}

        <Row label="How many" htmlFor={`${uid}-count`}>
          <input id={`${uid}-count`} type="number" inputMode="numeric" min={1} max={MAX_RECEIPT_COUNT} value={count}
            onChange={(e) => setCount(e.target.value)} className={`${control} w-28`} {...described("count", `${uid}-count-hint`)} />
          {err("count")}
          <p id={`${uid}-count-hint`} className="mt-1 text-[13px] text-ink-3">Each paper gets its own DOC-ID, so it can be scanned, reviewed and returned on its own.</p>
        </Row>

        <Row label="Handed over by (required)" htmlFor={`${uid}-handed`}>
          <input id={`${uid}-handed`} value={handedOverName} onChange={(e) => setHandedOverName(e.target.value)} maxLength={120} autoComplete="off"
            aria-required="true" placeholder="e.g. Client's accountant, or Courier — Blue Dart" className={control} {...described("handedOverName")} />
          {err("handedOverName")}
          <label className="mt-2 flex items-start gap-2 text-[13.5px]">
            <input type="checkbox" checked={returnable} onChange={(e) => setReturnable(e.target.checked)} className="mt-1 h-4 w-4 accent-accent" />
            <span>Returnable <span className="text-ink-3">— the client wants these back</span></span>
          </label>
        </Row>

        <Row label="Received on" htmlFor={`${uid}-received-on`}>
          <input id={`${uid}-received-on`} type="date" value={receivedOn} max={today} onChange={(e) => setReceivedOn(e.target.value)} className={`${control} w-auto`} {...described("receivedOn")} />
          {err("receivedOn")}
        </Row>

        <Row label="Channel" htmlFor={`${uid}-channel`}>
          <select id={`${uid}-channel`} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={`${control} w-auto`} {...described("channel")}>
            {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          {err("channel")}
        </Row>

        <Row label="Remark" htmlFor={`${uid}-remark`}>
          <input id={`${uid}-remark`} value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={500} autoComplete="off" className={control} {...described("remark")} />
          {err("remark")}
        </Row>
      </Card>
      {error && <p role="alert" className="mt-3 text-bad">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Link href="/inbox" className="inline-flex items-center rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Cancel</Link>
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Log receipt"}</Button>
      </div>
    </form>
  );
}

function Row({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 px-5 py-4 sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-4">
      <label htmlFor={htmlFor} className="pt-1.5 text-[13.5px] font-medium">{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
