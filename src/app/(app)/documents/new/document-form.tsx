"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { searchClients } from "@/lib/clients/actions";
import {
  loadClientTypes, proposeType, saveDocument, startUpload, suggestTypes, updateDocumentAction, type Suggestion,
} from "@/lib/documents/actions";
import { allowedPeriodKinds, defaultPeriod } from "@/lib/documents/period";
import type { ClientOption, ClientTypes, DocumentForForm, PeriodOption, TypeOption } from "@/lib/documents/queries";
import {
  ACCEPT_ATTRIBUTE, CHANNELS, RECEIVED_AS, validateFile, type Channel, type ReceivedAs, type ValidFile,
} from "@/lib/validation/document";
import { Button, Card } from "@/components/ui";
import { putFile } from "@/lib/documents/upload-client";
import type { Prefill } from "@/lib/expected/prefill";

// Add document (mockup 12, spec AC-1 … AC-5, AC-15). The file uploads straight to private Storage as soon as it
// is chosen (signed URL from the server), so "Save" is usually instant. ≤ 3 clicks after choosing the file when
// client and type are known: type (select) → Save to vault; the period defaults to the one that just ended.

type Props = {
  initialClient: ClientOption | null;
  initialTypes: ClientTypes;
  periods: PeriodOption[];
  groups: { id: string; name: string }[];
  today: string;
  canPropose: boolean;
  returnTo: string;
  /** Assign (Inbox) / edit: the same form for an existing document — no file here (new versions: document page). */
  existing?: DocumentForForm;
  /** From an expected row's "Upload" (04 AC-8): type, period and registration chosen already (validated server-side). */
  prefill?: Prefill | null;
  /** 10 (Client › Requested "Upload"): the document is filed for this ad-hoc item (client and type are the item's). */
  requestItemId?: string | null;
};

type Upload =
  | { status: "idle" }
  | { status: "uploading"; progress: number }
  | { status: "done"; path: string }
  | { status: "error"; error: string };

type PeriodChoice = "none" | "month" | "quarter" | "year";
const PERIOD_LABEL: Record<PeriodChoice, string> = { none: "Not needed", month: "Month", quarter: "Quarter", year: "Financial year" };
const NEW_TYPE = "__new__";

const control = "w-full rounded-[9px] border border-line-2 bg-panel px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft aria-[invalid=true]:border-bad";
const noSubscribe = () => () => {};
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function DocumentForm({ initialClient, initialTypes, periods, groups, today, canPropose, returnTo, existing, prefill, requestItemId }: Props) {
  const router = useRouter();
  const uid = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  // File + upload
  const [file, setFile] = useState<{ raw: File; valid: ValidFile } | null>(null);
  const [upload, setUpload] = useState<Upload>({ status: "idle" });
  const uploadRun = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Fields
  const existingPeriod = existing?.periodId ? periods.find((p) => p.id === existing.periodId) : undefined;
  const prefillType = !existing && prefill ? [...initialTypes.planTypes, ...initialTypes.otherTypes].find((t) => t.id === prefill.docTypeId) : undefined;
  const prefillDefault = prefillType ? defaultPeriod(prefillType.frequency, today) : null;
  const initialPeriod = existingPeriod ?? (prefillType
    ? periods.find((p) => p.id === prefill!.periodId)
      ?? (prefillDefault ? periods.find((p) => p.kind === prefillDefault.kind && p.code === prefillDefault.code) : undefined)
    : undefined);
  const [receivedAs, setReceivedAs] = useState<ReceivedAs>(existing?.receivedAs ?? "soft_copy");
  const [client, setClient] = useState<ClientOption | null>(existing ? existing.client : initialClient);
  const [types, setTypes] = useState<ClientTypes>(initialTypes);
  const [docTypeId, setDocTypeId] = useState(existing?.docTypeId ?? prefillType?.id ?? "");
  const [periodChoice, setPeriodChoice] = useState<PeriodChoice>(initialPeriod?.kind ?? "none");
  const [periodId, setPeriodId] = useState(initialPeriod?.id ?? "");
  const [registrationId, setRegistrationId] = useState(existing?.registrationId ?? (prefillType ? prefill!.registrationId : ""));
  const [channel, setChannel] = useState<Channel>((existing?.channel as Channel) ?? "whatsapp");
  const fromLink = existing?.channel === "upload_link";
  const [receivedOn, setReceivedOn] = useState(existing?.receivedOn ?? today);
  const [remark, setRemark] = useState(existing?.remark ?? "");

  // Client search
  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<ClientOption[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New type
  const [newName, setNewName] = useState("");
  const [newGroupId, setNewGroupId] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestedFor, setSuggestedFor] = useState("");
  const [newTypeError, setNewTypeError] = useState("");
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save
  const [saving, setSaving] = useState<"vault" | "inbox" | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const allTypes = useMemo(() => [...types.planTypes, ...types.otherTypes], [types]);
  const type: TypeOption | undefined = allTypes.find((t) => t.id === docTypeId);
  const kinds: PeriodChoice[] = type ? ["none", ...allowedPeriodKinds(type.periodKind)] : ["none", "month", "quarter", "year"];
  const regChoices = type?.registrationKind ? types.registrations.filter((r) => r.kind === type.registrationKind) : [];
  const periodOptions = periods.filter((p) => p.kind === periodChoice);
  const chosenPeriod = periods.find((p) => p.id === periodId);

  const fe = (f: string) => fieldErrors[f];
  const described = (f: string, hint?: string) => ({
    "aria-invalid": !!fe(f),
    "aria-describedby": [fe(f) && `${uid}-${f}-err`, hint].filter(Boolean).join(" ") || undefined,
  });
  const errText = (f: string) => fe(f) ? <p id={`${uid}-${f}-err`} className="mt-1 text-[13px] text-bad">{fe(f)}</p> : null;

  // ── File ───────────────────────────────────────────────────────────────────
  async function chooseFile(raw: File | undefined) {
    if (!raw) return;
    const v = validateFile({ name: raw.name, size: raw.size, type: raw.type });
    const run = ++uploadRun.current;
    setFieldErrors((e) => ({ ...e, file: "" }));
    if (!v.data) {
      setFile(null);
      setUpload({ status: "error", error: v.error ?? "This file can't be added." });
      return;
    }
    setFile({ raw, valid: v.data });
    setUpload({ status: "uploading", progress: 0 });
    const ticket = await startUpload({ name: raw.name, size: raw.size, type: raw.type });
    if (run !== uploadRun.current) return;
    if (!ticket.ok) { setUpload({ status: "error", error: ticket.error }); return; }
    try {
      await putFile(ticket.signedUrl, raw, ticket.contentType, (p) => { if (run === uploadRun.current) setUpload({ status: "uploading", progress: p }); });
      if (run === uploadRun.current) setUpload({ status: "done", path: ticket.path });
    } catch {
      if (run === uploadRun.current) setUpload({ status: "error", error: "The upload failed. Check your connection and add the file again." });
    }
  }

  // A file chosen before React attached its handlers (the page is visible ~1 s earlier on a deployed site, longer
  // on a slow phone) fired `change` with no listener. Pick it up once, on hydration — nothing is lost.
  // Until then the Save buttons stay disabled: a native submit before hydration would send the form as a GET
  // (field values, e.g. the remark, in the URL) and "Save to inbox" would do nothing.
  const pickedEarly = useRef(false);
  const ready = useSyncExternalStore(noSubscribe, () => true, () => false); // false in server HTML and during hydration
  useEffect(() => {
    if (pickedEarly.current) return;
    pickedEarly.current = true;
    const early = fileInput.current?.files?.[0];
    if (early) void chooseFile(early);
  }, []); // once, at hydration

  function removeFile() {
    uploadRun.current++;
    setFile(null);
    setUpload({ status: "idle" });
    if (fileInput.current) fileInput.current.value = "";
  }

  // ── Client ─────────────────────────────────────────────────────────────────
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
    setClient(c);
    setClientQuery("");
    setClientResults([]);
    setRegistrationId("");
    const r = await loadClientTypes(c?.id ?? null);
    if (!r.ok) { setError(r.error); return; }
    setTypes({ planTypes: r.planTypes, otherTypes: r.otherTypes, registrations: r.registrations });
    const still = [...r.planTypes, ...r.otherTypes].find((t) => t.id === docTypeId);
    if (!still) { setDocTypeId(""); setPeriodChoice("none"); setPeriodId(""); }
    else applyType(still, r.registrations);
  }

  // ── Type → group, period default, registration (AC-3) ────────────────────
  function applyType(t: TypeOption | undefined, registrations = types.registrations) {
    setFieldErrors((e) => ({ ...e, docTypeId: "", periodId: "", registrationId: "" }));
    if (!t) { setPeriodChoice("none"); setPeriodId(""); setRegistrationId(""); return; }
    const d = defaultPeriod(t.frequency, today);
    const p = d ? periods.find((x) => x.kind === d.kind && x.code === d.code) : undefined;
    setPeriodChoice(p ? p.kind : "none");
    setPeriodId(p?.id ?? "");
    const regs = t.registrationKind ? registrations.filter((r) => r.kind === t.registrationKind) : [];
    setRegistrationId(regs.length === 1 ? regs[0].id : "");
  }

  function onTypeChange(id: string) {
    setDocTypeId(id);
    if (id !== NEW_TYPE) applyType(allTypes.find((t) => t.id === id));
    else { setPeriodChoice("none"); setPeriodId(""); setRegistrationId(""); }
  }

  function onPeriodChoice(k: PeriodChoice) {
    setPeriodChoice(k);
    if (k === "none") { setPeriodId(""); return; }
    const want = type ? defaultPeriod(type.frequency, today) : null;
    const same = want && want.kind === k ? periods.find((p) => p.kind === k && p.code === want.code) : undefined;
    setPeriodId((same ?? periods.find((p) => p.kind === k))?.id ?? "");
  }

  // ── New (proposed) type (AC-15) ────────────────────────────────────────────
  function onNewName(v: string) {
    setNewName(v);
    setNewTypeError("");
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (v.trim().length < 2) { setSuggestions([]); return; }
    suggestTimer.current = setTimeout(async () => { setSuggestions(await suggestTypes(client?.id ?? null, v)); setSuggestedFor(v); }, 250);
  }

  function pickSuggestion(s: Suggestion) {
    setNewName(""); setSuggestions([]);
    const t = allTypes.find((x) => x.id === s.id);
    setDocTypeId(s.id);
    applyType(t);
  }

  async function createNewType() {
    if (!client) return;
    const group = groups.find((g) => g.id === newGroupId);
    if (!group) { setNewTypeError("Choose the group this type belongs to."); return; }
    const r = await proposeType(client.id, group, newName);
    if (!r.ok) { setNewTypeError(r.error); return; }
    setTypes((t) => ({ ...t, planTypes: [...t.planTypes, r.type] }));
    setDocTypeId(r.type.id);
    setNewName(""); setSuggestions([]); setNewGroupId("");
    applyType(r.type);
  }

  // ── Save (AC-4) ────────────────────────────────────────────────────────────
  async function save(target: "vault" | "inbox") {
    setError("");
    if (upload.status === "uploading") { setError("Wait for the upload to finish."); return; }
    setSaving(target);
    const fields = {
      target, receivedAs, channel, receivedOn, remark,
      clientId: client?.id ?? "", docTypeId: docTypeId === NEW_TYPE ? "" : docTypeId,
      periodId: periodChoice === "none" ? "" : periodId, registrationId,
    };
    const r = existing ? await updateDocumentAction({ id: existing.id, ...fields }) : await saveDocument({
      ...fields, requestItemId: requestItemId ?? null,
      file: file && upload.status === "done"
        ? { path: upload.path, size: file.valid.size, mime: file.valid.mime, fileName: file.valid.fileName } : null,
    });
    setSaving(null);
    if (!r.ok) { setError(r.error); setFieldErrors(r.fieldErrors); return; }
    router.push(`${returnTo}${returnTo.includes("?") ? "&" : "?"}saved=${encodeURIComponent(r.docCode)}`); // AC-4: back where the user came from
  }

  const busy = saving !== null;
  const uploading = upload.status === "uploading";

  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); void save("vault"); }} className="space-y-4">
      {error && <p role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{error}</p>}

      {existing ? (
        <Card className="px-5 py-4 text-[13.5px]">
          <span className="font-medium">{existing.docCode}</span>
          <span className="text-ink-2"> · {existing.fileName ?? "No file (hard copy or original)"}</span>
          {existing.versionCount > 1 && <span className="text-ink-3"> · {existing.versionCount} versions</span>}
        </Card>
      ) : (<>
      {/* Drop zone = a real, labelled file input (a11y); dropping a file does the same as browsing. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void chooseFile(e.dataTransfer.files?.[0]); }}
        className={`rounded-xl border border-dashed bg-panel px-6 py-7 text-center shadow-card focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${dragging ? "border-accent bg-accent-soft" : "border-line-2"}`}>
        <label htmlFor={`${uid}-file`} className="cursor-pointer font-medium">
          Drop a file here or <span className="text-accent underline">browse</span>
        </label>
        <input ref={fileInput} id={`${uid}-file`} type="file" accept={ACCEPT_ATTRIBUTE} className="sr-only"
          aria-describedby={`${uid}-file-hint ${fe("file") || upload.status === "error" ? `${uid}-file-err` : ""}`.trim()}
          onChange={(e) => void chooseFile(e.target.files?.[0])} />
        <p id={`${uid}-file-hint`} className="mt-1 text-[13px] text-ink-3">One file per document · optional for hard copies · up to 25 MB</p>
      </div>

      {(file || upload.status === "error" || fe("file")) && (
        <div className="space-y-2">
          {file && (
            <div className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13.5px]">
              <span className="truncate" title={file.valid.fileName}>{file.valid.fileName}</span>
              <span className="shrink-0 text-ink-3">{kb(file.valid.size)}</span>
              <button type="button" onClick={removeFile} aria-label="Remove file" className="shrink-0 rounded px-1 text-ink-2 hover:bg-canvas">×</button>
            </div>
          )}
          {uploading && (
            <div className="max-w-sm">
              <progress max={100} value={upload.progress} aria-label="Upload progress" className="h-1.5 w-full" />
              <p className="text-[13px] text-ink-2">Uploading… {upload.progress}%<span role="status" className="sr-only">Uploading</span></p>
            </div>
          )}
          {upload.status === "done" && <p role="status" className="text-[13px] text-ok">Uploaded</p>}
          {(upload.status === "error" || fe("file")) && (
            <p id={`${uid}-file-err`} role="alert" className="text-[13px] text-bad">{upload.status === "error" ? upload.error : fe("file")}</p>
          )}
        </div>
      )}

      </>)}

      <Card className="divide-y divide-line">
        {/* Received as */}
        <Row label="Received as" as="fieldset">
          <Segmented name={`${uid}-ra`} value={receivedAs} onChange={(v) => setReceivedAs(v as ReceivedAs)}
            options={RECEIVED_AS.map((r) => ({ value: r.value, label: r.label }))} />
        </Row>

        {/* Client */}
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
                placeholder="Search by name, code or PAN" onChange={(e) => onClientQuery(e.target.value)}
                className={control} {...described("clientId", `${uid}-client-hint`)} />
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
          {errText("clientId")}
          <p id={`${uid}-client-hint`} className="mt-1 text-[13px] text-ink-3">
            Not sure who this belongs to?{" "}
            <button type="button" onClick={() => void save("inbox")} disabled={!ready || busy || uploading} className="text-accent hover:underline disabled:opacity-50">Leave it in inbox</button>
          </p>
        </Row>

        {/* Document type */}
        <Row label="Document type" htmlFor={`${uid}-type`}>
          <select id={`${uid}-type`} value={docTypeId} onChange={(e) => onTypeChange(e.target.value)} className={control} {...described("docTypeId", `${uid}-type-hint`)}>
            <option value="">Choose a type…</option>
            {types.planTypes.length > 0 && (
              <optgroup label={`Active for ${client?.name ?? "this client"}`}>
                {types.planTypes.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.groupName}{t.proposed ? " (proposed)" : ""}</option>)}
              </optgroup>
            )}
            <optgroup label={client ? "Other types" : "All types"}>
              {types.otherTypes.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.groupName}</option>)}
            </optgroup>
            {client && canPropose && <option value={NEW_TYPE}>+ New type for this client…</option>}
          </select>
          {errText("docTypeId")}
          <p id={`${uid}-type-hint`} className="mt-1 text-[13px] text-ink-3">
            {type ? <>Group <strong className="font-semibold text-ink">{type.groupName}</strong> · set from the type.{type.proposed ? " Proposed — waiting for approval." : ""}</>
              : client ? "Types active for this client are listed first." : "Choose a client to see their types first."}
          </p>

          {docTypeId === NEW_TYPE && (
            <div className="mt-3 space-y-3 rounded-lg border border-line bg-canvas p-3">
              <div>
                <label htmlFor={`${uid}-newname`} className="block text-[13.5px] font-medium">New type name</label>
                <input id={`${uid}-newname`} value={newName} onChange={(e) => onNewName(e.target.value)} maxLength={120} autoComplete="off" className={`mt-1 ${control}`} />
              </div>
              {suggestions.length > 0 && (
                <div>
                  <p className="text-[13px] text-ink-2">Did you mean…</p>
                  <ul className="mt-1 flex flex-wrap gap-2" aria-label="Existing types that match">
                    {suggestions.slice(0, 5).map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => pickSuggestion(s)} className="rounded-full border border-line-2 bg-panel px-3 py-1 text-[13px] hover:bg-accent-soft">
                          {s.name} <span className="text-ink-3">· {s.groupName}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* AC-15: offered only once the closest existing types for this name have been shown. */}
              {newName.trim().length >= 2 && suggestedFor === newName && (
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label htmlFor={`${uid}-newgroup`} className="block text-[13.5px] font-medium">Group</label>
                    <select id={`${uid}-newgroup`} value={newGroupId} onChange={(e) => setNewGroupId(e.target.value)} className={`mt-1 ${control} w-48`}>
                      <option value="">Choose…</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                  <Button type="button" variant="secondary" onClick={() => void createNewType()}>+ New type “{newName.trim()}” for this client</Button>
                </div>
              )}
              {newTypeError && <p role="alert" className="text-[13px] text-bad">{newTypeError}</p>}
              <p className="text-[13px] text-ink-3">A new type joins this client&apos;s plan (as needed, no reminders) and waits for an Admin or Manager to approve it.</p>
            </div>
          )}
        </Row>

        {/* Period */}
        <Row label="Period" as="fieldset">
          <Segmented name={`${uid}-pk`} value={periodChoice} onChange={(v) => onPeriodChoice(v as PeriodChoice)}
            options={kinds.map((k) => ({ value: k, label: PERIOD_LABEL[k] }))} />
          {periodChoice !== "none" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`${uid}-period`}>{PERIOD_LABEL[periodChoice]}</label>
              <select id={`${uid}-period`} value={periodId} onChange={(e) => setPeriodId(e.target.value)} className={`${control} w-auto min-w-48`} {...described("periodId")}>
                {periodOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {chosenPeriod && <span className="text-[13px] text-ink-3">FY {chosenPeriod.fyCode}</span>}
            </div>
          )}
          {errText("periodId")}
          {type && type.frequency !== "as_needed" && (
            <p className="mt-1 text-[13px] text-ink-3">{type.name} is collected {type.frequency} for this client — the period that just ended is preselected.</p>
          )}
        </Row>

        {/* Registration (GST → GSTIN, TDS → TAN) */}
        {type?.registrationKind && regChoices.length > 0 && (
          <Row label={type.registrationKind === "gstin" ? "GSTIN" : "TAN"} htmlFor={`${uid}-reg`}>
            <select id={`${uid}-reg`} value={registrationId} onChange={(e) => setRegistrationId(e.target.value)} className={control} {...described("registrationId")}>
              <option value="">Not specified</option>
              {regChoices.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
            </select>
            {errText("registrationId")}
          </Row>
        )}

        {/* Channel + received on */}
        <Row label="Received" as="fieldset">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-channel`} className="block text-[13px] text-ink-2">Channel</label>
              {fromLink ? (
                // 10: a document sent by upload link keeps its channel (the database refuses a change).
                <input id={`${uid}-channel`} readOnly value="Upload link" className={`mt-1 ${control} bg-canvas`} {...described("channel")} />
              ) : (
                <select id={`${uid}-channel`} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={`mt-1 ${control}`} {...described("channel")}>
                  {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              )}
            </div>
            <div>
              <label htmlFor={`${uid}-received-on`} className="block text-[13px] text-ink-2">Received on</label>
              <input id={`${uid}-received-on`} type="date" value={receivedOn} max={today} onChange={(e) => setReceivedOn(e.target.value)} className={`mt-1 ${control}`} {...described("receivedOn")} />
            </div>
          </div>
          {errText("channel")}{errText("receivedOn")}
        </Row>

        {/* Remark */}
        <Row label="Remark" htmlFor={`${uid}-remark`}>
          <textarea id={`${uid}-remark`} value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={500} rows={2}
            placeholder="Optional — anything the team should know" className={control} {...described("remark")} />
          {errText("remark")}
        </Row>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!ready || busy || uploading}>{saving === "vault" ? "Saving…" : existing?.classified ? "Save changes" : "Save to vault"}</Button>
        {!existing?.classified && (
          <Button type="button" variant="secondary" disabled={!ready || busy || uploading} onClick={() => void save("inbox")}>
            {saving === "inbox" ? "Saving…" : existing ? "Keep in inbox" : "Save to inbox"}
          </Button>
        )}
      </div>
    </form>
  );
}

function Row({ label, htmlFor, as, children }: { label: string; htmlFor?: string; as?: "fieldset"; children: React.ReactNode }) {
  const grid = "grid gap-2 px-5 py-4 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4";
  if (as === "fieldset") {
    return (
      <fieldset className={grid}>
        <legend className="float-left pt-1.5 text-[13.5px] font-medium sm:w-[150px]">{label}</legend>
        <div className="min-w-0 sm:col-start-2">{children}</div>
      </fieldset>
    );
  }
  return (
    <div className={grid}>
      <label htmlFor={htmlFor} className="pt-1.5 text-[13.5px] font-medium">{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Segmented({ name, value, onChange, options }: {
  name: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex flex-wrap rounded-[9px] bg-canvas p-0.5">
      {options.map((o) => (
        <label key={o.value} className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13.5px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${value === o.value ? "bg-panel font-medium shadow-card" : "text-ink-2"}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
          {o.label}
        </label>
      ))}
    </div>
  );
}
