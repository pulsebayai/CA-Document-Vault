"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { importClientsChunk, previewImport } from "@/lib/clients/actions";
import {
  MAX_BYTES, chunkRows, decodeUtf8, errorRowsCsv, issuesText, parseImportCsv, templateCsv,
  type ImportCounts, type PreviewRow, type RawRow, type RowStatus,
} from "@/lib/csv/parse";

// Spec AC-13 … AC-16: upload → preview (nothing written) → import in chunks of 200 → result.
// The file is read in the browser only; the server re-validates every row before it writes anything.

type Step =
  | { kind: "upload" }
  | { kind: "preview"; rows: RawRow[]; preview: PreviewRow[]; counts: ImportCounts }
  | { kind: "importing"; done: number; total: number }
  | { kind: "result"; created: { row: number; code: string }[]; skipped: number; failed: { raw: RawRow; reason: string }[] };

const STATUS: Record<RowStatus, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  valid: { label: "Ready", tone: "ok" },
  warning: { label: "Warning", tone: "warn" },
  error: { label: "Error", tone: "bad" },
  duplicate: { label: "Duplicate — skipped", tone: "muted" },
};

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const n = (x: number) => x.toLocaleString("en-IN");

export function ImportView() {
  const [step, setStep] = useState<Step>({ kind: "upload" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();

  async function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) return setError("The file is larger than 1 MB. Split it into smaller files.");
    setBusy(true);
    try {
      const text = decodeUtf8(await file.arrayBuffer());
      if (text === null) return setError("The file isn't UTF-8. In Excel, use Save As › \"CSV UTF-8 (Comma delimited)\".");
      const parsed = parseImportCsv(text, file.size);
      if (!parsed.ok) return setError(parsed.error);
      const res = await previewImport(parsed.rows);
      if (!res.ok) return setError(res.error);
      setProblemsOnly(false);
      setStep({ kind: "preview", rows: parsed.rows, preview: res.preview, counts: res.counts });
    } catch {
      setError("Could not read the file. Please try again.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function runImport(rows: RawRow[], preview: PreviewRow[]) {
    const status = new Map(preview.map((p) => [p.row, p]));
    const toImport = rows.filter((r) => ["valid", "warning"].includes(status.get(r.row)?.status ?? ""));
    const failed = rows
      .filter((r) => status.get(r.row)?.status === "error")
      .map((raw) => ({ raw, reason: issuesText(status.get(raw.row)!.issues) }));
    let skipped = preview.filter((p) => p.status === "duplicate").length;
    const created: { row: number; code: string }[] = [];
    const byRow = new Map(rows.map((r) => [r.row, r]));

    setError(null);
    setStep({ kind: "importing", done: 0, total: toImport.length });
    const chunks = chunkRows(toImport);
    for (let i = 0; i < chunks.length; i++) {
      let res: Awaited<ReturnType<typeof importClientsChunk>>;
      try {
        res = await importClientsChunk(chunks[i]);
      } catch {
        res = { ok: false, error: "The connection was interrupted." };
      }
      if (!res.ok) {
        // Stop here: later rows are reported as not imported, so the error file can be uploaded again.
        chunks.slice(i).flat().forEach((raw) => failed.push({ raw, reason: `Not imported: ${res.ok ? "" : res.error}` }));
        setError(`${res.error} ${n(created.length)} clients were imported before this; the rest are in the error file.`);
        break;
      }
      created.push(...res.created);
      skipped += res.skipped.length;
      res.rejected.forEach((r) => failed.push({ raw: byRow.get(r.row)!, reason: r.reason }));
      setStep({ kind: "importing", done: chunks.slice(0, i + 1).reduce((s, c) => s + c.length, 0), total: toImport.length });
    }
    failed.sort((a, b) => a.raw.row - b.raw.row);
    setStep({ kind: "result", created, skipped, failed });
  }

  const templateButton = (
    <Button type="button" variant="secondary" onClick={() => download("client-import-template.csv", templateCsv())}>Download template</Button>
  );

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-[9px] border border-bad/30 bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{error}</p>}

      {step.kind === "upload" && (
        <Card className="space-y-4 p-6">
          <ol className="list-decimal space-y-1 pl-5 text-[13.5px] text-ink-2">
            <li>Download the template and copy your clients into it — one client per row.</li>
            <li>Separate several GSTINs, TANs or groups with <code>;</code>. Leave <code>groups</code> blank to use the groups ticked &ldquo;Enabled for new clients&rdquo;.</li>
            <li>Save as <strong>CSV UTF-8</strong> (up to 2,000 rows, 1 MB) and upload it. You&rsquo;ll see a preview before anything is saved.</li>
          </ol>
          <div className="flex flex-wrap items-end gap-3">
            {templateButton}
            <label htmlFor={fileId} className="block text-[13.5px] font-medium">CSV file
              <input id={fileId} ref={fileRef} type="file" accept=".csv,text/csv" disabled={busy}
                onChange={(e) => onFile(e.target.files?.[0])}
                className="mt-1 block text-[13.5px] file:mr-3 file:rounded-[9px] file:border file:border-line-2 file:bg-panel file:px-3 file:py-2 file:font-medium" />
            </label>
          </div>
          {busy && <p role="status" className="text-[13.5px] text-ink-3">Checking the file…</p>}
        </Card>
      )}

      {step.kind === "preview" && (
        <PreviewPanel step={step} problemsOnly={problemsOnly} setProblemsOnly={setProblemsOnly}
          onImport={() => runImport(step.rows, step.preview)}
          onErrors={() => {
            const status = new Map(step.preview.map((p) => [p.row, p]));
            download("client-import-errors.csv", errorRowsCsv(step.rows
              .filter((r) => status.get(r.row)?.status === "error")
              .map((raw) => ({ raw, reason: issuesText(status.get(raw.row)!.issues) }))));
          }}
          onRestart={() => { setError(null); setStep({ kind: "upload" }); }} />
      )}

      {step.kind === "importing" && (
        <Card className="p-6">
          <p role="status" aria-live="polite" className="font-medium">Importing… {n(step.done)} of {n(step.total)} rows</p>
          <p className="mt-1 text-[13.5px] text-ink-3">Keep this page open until the import finishes.</p>
        </Card>
      )}

      {step.kind === "result" && (
        <Card className="space-y-4 p-6">
          <div role="status">
            <h2 className="text-lg font-semibold">
              {n(step.created.length)} {step.created.length === 1 ? "client" : "clients"} imported
              {step.created.length > 0 && <span className="font-normal text-ink-3"> ({step.created[0].code}{step.created.length > 1 ? ` – ${step.created[step.created.length - 1].code}` : ""})</span>}
            </h2>
            <ul className="mt-2 space-y-0.5 text-[13.5px] text-ink-2">
              <li>{n(step.skipped)} duplicates skipped</li>
              <li>{n(step.failed.length)} {step.failed.length === 1 ? "row" : "rows"} not imported</li>
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            {step.failed.length > 0 && (
              <Button type="button" onClick={() => download("client-import-errors.csv", errorRowsCsv(step.failed))}>Download error rows</Button>
            )}
            <Button type="button" variant="secondary" onClick={() => { setError(null); setStep({ kind: "upload" }); }}>Import another file</Button>
            <Link href="/clients" className="inline-flex items-center rounded-[9px] border border-line-2 bg-panel px-3.5 py-2 font-medium hover:bg-canvas">Go to clients</Link>
          </div>
          {step.failed.length > 0 && (
            <p className="text-[13.5px] text-ink-3">Fix the rows in the error file (the <code>error</code> column says what is wrong) and upload it again.</p>
          )}
        </Card>
      )}
    </div>
  );
}

function PreviewPanel({ step, problemsOnly, setProblemsOnly, onImport, onErrors, onRestart }: {
  step: Extract<Step, { kind: "preview" }>; problemsOnly: boolean; setProblemsOnly: (v: boolean) => void;
  onImport: () => void; onErrors: () => void; onRestart: () => void;
}) {
  const { counts } = step;
  const rows = problemsOnly ? step.preview.filter((p) => p.status !== "valid") : step.preview;
  const tiles: [string, number][] = [
    ["Rows in file", counts.total], ["Ready to import", counts.importable], ["Errors", counts.errors],
    ["Duplicates", counts.duplicates], ["Warnings", counts.warnings],
  ];
  return (
    <>
      <Card className="p-5">
        <h2 className="text-lg font-semibold">Preview — nothing has been saved yet</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Import summary">
          {tiles.map(([label, value]) => (
            <div key={label} className="rounded-[9px] border border-line px-3 py-2">
              <dt className="text-[12.5px] text-ink-3">{label}</dt>
              <dd className="text-[20px] font-semibold tabular-nums">{n(value)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" disabled={counts.importable === 0} onClick={onImport}>
            Import {n(counts.importable)} valid {counts.importable === 1 ? "row" : "rows"}
          </Button>
          {counts.errors > 0 && <Button type="button" variant="secondary" onClick={onErrors}>Download error rows</Button>}
          <Button type="button" variant="secondary" onClick={onRestart}>Choose another file</Button>
          <label className="ml-auto flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
            Only rows with problems
          </label>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-[13.5px]">
          <caption className="sr-only">Rows in the file, with any problems</caption>
          <thead className="border-b border-line text-ink-3">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Row</th>
              <th scope="col" className="px-4 py-2 font-medium">Client name</th>
              <th scope="col" className="px-4 py-2 font-medium">Status</th>
              <th scope="col" className="px-4 py-2 font-medium">Problems</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.row} className="border-b border-line last:border-0 align-top">
                <th scope="row" className="px-4 py-2 font-normal tabular-nums">{p.row}</th>
                <td className="px-4 py-2">{p.name || <span className="text-ink-3">(no name)</span>}</td>
                <td className="whitespace-nowrap px-4 py-2"><Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge></td>
                <td className="px-4 py-2">
                  {p.issues.length === 0 ? <span className="text-ink-3">—</span> : (
                    <ul className="space-y-0.5">
                      {p.issues.map((i, k) => <li key={k}><code className="text-ink-3">{i.column}</code>: {i.message}</li>)}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-ink-3">No rows with problems.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
