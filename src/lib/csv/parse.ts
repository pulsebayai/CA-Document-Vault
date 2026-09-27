import Papa from "papaparse";
import { CLIENT_TYPES, CLIENT_TYPE_LABEL, validateClient } from "@/lib/validation/client";
import { normaliseIdentifier } from "@/lib/validation/identifiers";

// Feature 02 — CSV import (spec AC-13 … AC-16). Pure functions: the browser uses them for the preview,
// and the server runs the same validation again before every insert (never trust the preview).
// Messages name the column and the problem, never the PAN/GSTIN/mobile/email value.

export const IMPORT_COLUMNS = [
  "name", "client_type", "pan", "previous_reference", "email", "mobile", "incharge_email", "gstins", "tans", "groups",
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
/** Extra column the error file adds; ignored on re-upload so the corrected file imports as-is. */
const ERROR_COLUMN = "error";

export const MAX_BYTES = 1024 * 1024;
export const MAX_ROWS = 2000;
export const CHUNK_SIZE = 200; // = import_clients' per-call limit
const MAX_CELL = 500;

export type RawRow = {
  /** Spreadsheet row number: the header is row 1. */
  row: number;
  cells: Record<ImportColumn, string>;
  /** File-level problem with this line (e.g. wrong number of columns). */
  problem?: string;
};
export type ParseResult = { ok: true; rows: RawRow[] } | { ok: false; error: string };

// A spreadsheet treats cells starting with these as formulas; the error file prefixes them with "'".
const FORMULA_START = /^[=+\-@\t\r]/;

export function decodeUtf8(buf: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Header + limits (AC-14). `bytes` defaults to the text's UTF-8 size. */
export function parseImportCsv(text: string, bytes = new TextEncoder().encode(text).length): ParseResult {
  if (bytes > MAX_BYTES) return { ok: false, error: "The file is larger than 1 MB. Split it into smaller files." };
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const parsed = Papa.parse<string[]>(src, { skipEmptyLines: "greedy" });
  const table = parsed.data;
  if (!table.length) return { ok: false, error: "The file is empty. Use the template's header row." };

  const header = table[0].map((h) => h.trim().toLowerCase());
  if (header[header.length - 1] === ERROR_COLUMN) header.pop();
  const missing = IMPORT_COLUMNS.filter((c) => !header.includes(c));
  const unknown = header.filter((h) => !(IMPORT_COLUMNS as readonly string[]).includes(h));
  const repeated = header.filter((h, i) => header.indexOf(h) !== i);
  if (missing.length || unknown.length || repeated.length) {
    const parts = [
      missing.length && `missing ${missing.join(", ")}`,
      unknown.length && `unknown ${unknown.map((u) => u || "(blank)").join(", ")}`,
      repeated.length && `repeated ${[...new Set(repeated)].join(", ")}`,
    ].filter(Boolean);
    return { ok: false, error: `The header row doesn't match the template (${parts.join("; ")}). Download the template and copy your data into it.` };
  }

  const body = table.slice(1);
  if (!body.length) return { ok: false, error: "The file has a header but no client rows." };
  if (body.length > MAX_ROWS) return { ok: false, error: `The file has ${body.length.toLocaleString("en-IN")} rows; the limit is 2,000. Split it into smaller files.` };

  const width = table[0].length;
  const rows = body.map((cells, i): RawRow => {
    const out = {} as Record<ImportColumn, string>;
    header.forEach((h, c) => { out[h as ImportColumn] = unescapeCell(cells[c] ?? ""); });
    const r: RawRow = { row: i + 2, cells: out };
    if (cells.length !== width && !(cells.length === header.length)) {
      r.problem = `This row has ${cells.length} columns; the header has ${width}.`;
    }
    return r;
  });
  return { ok: true, rows };
}

const unescapeCell = (v: string) => (v.startsWith("'") && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v);

// ── Row validation ──────────────────────────────────────────────────────────
export type ImportContext = {
  /** lower-case email → staff id (active staff of the office). */
  staffByEmail: Map<string, string>;
  /** lower-case group name → group id (active groups). */
  groupsByName: Map<string, string>;
  /** Groups ticked "Enabled for new clients": used when the groups cell is blank. */
  defaultGroupIds: string[];
  /** PAN → client code, for non-archived clients. */
  existingPans: Map<string, string>;
  /** lower-case names of non-archived clients. */
  existingNames: Set<string>;
  /** Every GSTIN/TAN already on a client (unique per office, active or not). */
  existingRegistrations: Set<string>;
};
export type RowIssue = { column: ImportColumn; message: string };
export type RowStatus = "valid" | "warning" | "error" | "duplicate";
export type PreviewRow = { row: number; name: string; status: RowStatus; issues: RowIssue[] };
export type ImportPayload = {
  name: string; client_type: string; pan: string | null; previous_reference: string | null; email: string | null;
  mobile: string | null; incharge_id: string; registrations: { kind: "gstin" | "tan"; number: string }[]; group_ids: string[];
};
export type ImportCounts = { total: number; importable: number; errors: number; duplicates: number; warnings: number };
export type ValidationResult = { preview: PreviewRow[]; ready: { row: number; payload: ImportPayload }[]; counts: ImportCounts };

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
const TYPE_BY_NAME = new Map<string, string>(
  CLIENT_TYPES.flatMap((t) => [[squash(t), t], [squash(CLIENT_TYPE_LABEL[t]), t]] as [string, string][]),
);
const list = (v: string) => v.split(";").map((s) => s.trim()).filter(Boolean);

const FIELD_TO_COLUMN: Record<string, ImportColumn> = {
  name: "name", clientType: "client_type", pan: "pan", previousReference: "previous_reference",
  email: "email", mobile: "mobile", inchargeId: "incharge_email",
};

export function validateImportRows(rows: RawRow[], ctx: ImportContext): ValidationResult {
  const preview: PreviewRow[] = [];
  const ready: ValidationResult["ready"] = [];
  const pansInFile = new Map<string, number>(); // PAN → row that will import it
  const regsInFile = new Set<string>();

  for (const r of rows) {
    const c = r.cells;
    const name = c.name.trim();
    const issues: RowIssue[] = [];
    const warnings: RowIssue[] = [];
    const done = (status: RowStatus, list: RowIssue[]) => preview.push({ row: r.row, name, status, issues: list });

    if (r.problem) { done("error", [{ column: "name", message: r.problem }]); continue; }
    for (const col of IMPORT_COLUMNS) {
      if (c[col].length > MAX_CELL) issues.push({ column: col, message: `Too long (${MAX_CELL} characters max).` });
    }
    if (issues.length) { done("error", issues); continue; }

    const typeRaw = c.client_type.trim();
    const clientType = TYPE_BY_NAME.get(squash(typeRaw)) ?? "";
    if (typeRaw && !clientType) issues.push({ column: "client_type", message: "Unknown client type. Use one from the template (e.g. Individual, HUF, Partnership firm, Private Ltd)." });

    const inchargeEmail = c.incharge_email.trim().toLowerCase();
    const inchargeId = inchargeEmail ? ctx.staffByEmail.get(inchargeEmail) : undefined;
    if (!inchargeEmail) issues.push({ column: "incharge_email", message: "Enter the incharge's email (an active staff member)." });
    else if (!inchargeId) issues.push({ column: "incharge_email", message: "No active staff member has this email." });

    const gstins = list(c.gstins);
    const tans = list(c.tans);
    const v = validateClient({
      name, clientType, pan: c.pan, previousReference: c.previous_reference, email: c.email, mobile: c.mobile,
      inchargeId: inchargeId ?? "00000000-0000-4000-8000-000000000000", // real problem reported above
      registrations: [...gstins.map((number) => ({ kind: "gstin", number })), ...tans.map((number) => ({ kind: "tan", number }))],
    });
    for (const e of v.errors) {
      if (e.field === "clientType" && typeRaw) continue; // already explained
      const m = /^registrations\.(\d+)/.exec(e.field);
      const column = m ? (Number(m[1]) < gstins.length ? "gstins" : "tans") : FIELD_TO_COLUMN[e.field] ?? "name";
      if (e.field === "clientType") issues.push({ column, message: "Enter the client type." });
      else issues.push({ column, message: e.message });
    }
    for (const w of v.warnings) warnings.push({ column: FIELD_TO_COLUMN[w.field] ?? "pan", message: w.message });

    let groupIds = ctx.defaultGroupIds;
    const groupNames = list(c.groups);
    if (groupNames.length) {
      groupIds = [];
      for (const g of groupNames) {
        const id = ctx.groupsByName.get(g.toLowerCase());
        if (!id) issues.push({ column: "groups", message: `Unknown group "${g}". Use the names in Settings › Document catalogue.` });
        else if (!groupIds.includes(id)) groupIds.push(id);
      }
    }

    if (issues.length || !v.data) { done("error", issues); continue; }
    const d = v.data;

    if (d.pan) {
      const code = ctx.existingPans.get(d.pan);
      if (code) { done("duplicate", [{ column: "pan", message: `Duplicate — client ${code} already has this PAN. Skipped.` }]); continue; }
      const earlier = pansInFile.get(d.pan);
      if (earlier) { done("duplicate", [{ column: "pan", message: `Duplicate — same PAN as row ${earlier} in this file. Skipped.` }]); continue; }
    }

    for (const reg of d.registrations) {
      const column = reg.kind === "gstin" ? "gstins" : "tans";
      const label = reg.kind === "gstin" ? "GSTIN" : "TAN";
      if (ctx.existingRegistrations.has(reg.number)) issues.push({ column, message: `This ${label} is already on another client.` });
      else if (regsInFile.has(reg.number)) issues.push({ column, message: `This ${label} is used by an earlier row in this file.` });
    }
    if (issues.length) { done("error", issues); continue; }

    if (!d.pan && ctx.existingNames.has(d.name.toLowerCase())) {
      warnings.push({ column: "name", message: "A client with the same name already exists. This row will add a separate client." });
    }

    if (d.pan) pansInFile.set(d.pan, r.row);
    d.registrations.forEach((reg) => regsInFile.add(reg.number));
    ready.push({
      row: r.row,
      payload: {
        name: d.name, client_type: d.clientType, pan: d.pan, previous_reference: d.previousReference, email: d.email,
        mobile: d.mobile, incharge_id: d.inchargeId, registrations: d.registrations.map((x) => ({ kind: x.kind, number: x.number })),
        group_ids: groupIds,
      },
    });
    done(warnings.length ? "warning" : "valid", warnings);
  }

  const count = (s: RowStatus) => preview.filter((p) => p.status === s).length;
  return {
    preview,
    ready,
    counts: { total: rows.length, importable: ready.length, errors: count("error"), duplicates: count("duplicate"), warnings: count("warning") },
  };
}

/** Normalised PAN of a raw row, for server-side lookups (only well-formed PANs matter). */
export const rowPan = (r: RawRow) => normaliseIdentifier(r.cells.pan);

export function chunkRows<T>(rows: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// ── Files (AC-13, AC-16) ─────────────────────────────────────────────────────
const TEMPLATE_EXAMPLE: Record<ImportColumn, string> = {
  name: "Example Traders", client_type: "Partnership firm", pan: "ZZZFZ0001Z", previous_reference: "OLD-001",
  email: "accounts@example.test", mobile: "9800000001", incharge_email: "staff@example.test",
  gstins: "33ZZZFZ0001Z1Z5", tans: "ZZZZ00001Z", groups: "GST;TDS/TCS",
};

export function templateCsv(): string {
  return `${Papa.unparse({ fields: [...IMPORT_COLUMNS], data: [IMPORT_COLUMNS.map((c) => TEMPLATE_EXAMPLE[c])] })}\r\n`;
}

/** Rejected rows as a CSV the user can fix and upload again. Formula-looking cells get a "'" prefix. */
export function errorRowsCsv(rows: { raw: RawRow; reason: string }[]): string {
  return `${Papa.unparse(
    { fields: [...IMPORT_COLUMNS, ERROR_COLUMN], data: rows.map(({ raw, reason }) => [...IMPORT_COLUMNS.map((c) => raw.cells[c]), reason]) },
    { escapeFormulae: true },
  )}\r\n`;
}

/** "email: Enter a valid email address.; pan: …" — for the error file. */
export const issuesText = (issues: RowIssue[]) => issues.map((i) => `${i.column}: ${i.message}`).join("; ");
