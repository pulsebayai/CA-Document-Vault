import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import {
  IMPORT_COLUMNS, MAX_BYTES, MAX_ROWS, chunkRows, decodeUtf8, errorRowsCsv, parseImportCsv, templateCsv,
  validateImportRows, type ImportContext, type RawRow,
} from "@/lib/csv/parse";
import { testGstin, testPan, testTan } from "../support/test-data";

// Feature 02 step 10 — CSV import rules (spec AC-13 … AC-16). The same functions run in the browser
// (preview) and on the server (re-validation before every insert).

const HEADER = IMPORT_COLUMNS.join(",");
const STAFF = "11111111-1111-4111-8111-111111111111";
const GST = "22222222-2222-4222-8222-222222222222";
const TDS = "33333333-3333-4333-8333-333333333333";
const DEFAULT_GROUP = "44444444-4444-4444-8444-444444444444";

const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
  staffByEmail: new Map([["asha@example.test", STAFF]]),
  groupsByName: new Map([["gst", GST], ["tds/tcs", TDS]]),
  defaultGroupIds: [DEFAULT_GROUP],
  existingPans: new Map(),
  existingNames: new Set(),
  existingRegistrations: new Set(),
  ...over,
});

type Cells = Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>;
const raw = (row: number, c: Cells): RawRow => ({
  row,
  cells: Object.fromEntries(IMPORT_COLUMNS.map((k) => [k, c[k] ?? ""])) as RawRow["cells"],
});
const ok = (row: number, c: Cells = {}) =>
  raw(row, { name: `Client ${row}`, client_type: "individual", incharge_email: "asha@example.test", ...c });

describe("template (AC-13)", () => {
  it("has the exact header and one synthetic example row that validates", () => {
    const lines = templateCsv().trim().split(/\r?\n/);
    expect(lines[0]).toBe("name,client_type,pan,previous_reference,email,mobile,incharge_email,gstins,tans,groups");
    expect(lines).toHaveLength(2);
    const parsed = parseImportCsv(templateCsv());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Example uses the reserved synthetic PAN pattern and a .test email — never real data.
    expect(parsed.rows[0].cells.pan).toMatch(/^ZZZ.Z\d{4}Z$/);
    expect(parsed.rows[0].cells.email).toMatch(/\.test$/);
  });
});

describe("file checks (AC-14)", () => {
  it("rejects a wrong header, naming what is missing or unknown", () => {
    const r = parseImportCsv("name,type,pan\nA,individual,\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/client_type/);
  });

  it("accepts the columns in any order and in any case, and a trailing error column (re-upload of the error file)", () => {
    const cols = [...IMPORT_COLUMNS].reverse().map((c) => c.toUpperCase());
    const r = parseImportCsv(`${cols.join(",")},error\n${cols.map((c) => (c === "NAME" ? "Rev Co" : "")).join(",")},Row fixed\n`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].cells.name).toBe("Rev Co");
  });

  it("rejects duplicate columns", () => {
    const r = parseImportCsv(`${HEADER},name\n`);
    expect(r.ok).toBe(false);
  });

  it("rejects more than 2,000 rows and files over 1 MB", () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `C${i},individual,,,,,a@example.test,,,`).join("\n");
    const r = parseImportCsv(`${HEADER}\n${rows}\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/2,000/);
    const big = parseImportCsv(`${HEADER}\n`, MAX_BYTES + 1);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/1 MB/);
  });

  it("rejects a file with no data rows", () => {
    const r = parseImportCsv(`${HEADER}\n\n`);
    expect(r.ok).toBe(false);
  });

  it("strips a UTF-8 BOM, skips blank lines, numbers rows as in a spreadsheet (header = row 1)", () => {
    const r = parseImportCsv(`﻿${HEADER}\nA,individual,,,,,a@example.test,,,\n\n`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].row).toBe(2);
    }
  });

  it("flags a row with the wrong number of columns instead of guessing", () => {
    const r = parseImportCsv(`${HEADER}\nA,individual\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateImportRows(r.rows, ctx());
    expect(v.preview[0].status).toBe("error");
    expect(v.preview[0].issues[0].message).toMatch(/columns/);
  });

  it("decodes UTF-8 and refuses other encodings", () => {
    expect(decodeUtf8(new TextEncoder().encode("Café").buffer)).toBe("Café");
    expect(decodeUtf8(new Uint8Array([0x43, 0x61, 0x66, 0xe9]).buffer)).toBeNull(); // Latin-1 "Café"
  });
});

describe("row validation (AC-14, same rules as the Add client form)", () => {
  it("valid row → import payload with incharge, registrations and groups resolved", () => {
    const pan = testPan("F", 1);
    const v = validateImportRows([ok(2, {
      name: " Kaveri Textiles ", client_type: "Partnership firm", pan: pan.toLowerCase(), previous_reference: "K-9",
      email: "Accounts@Example.test", mobile: "+91 98450 12345", incharge_email: "ASHA@example.test",
      gstins: `${testGstin(pan)}; ${testGstin(pan, "29")}`, tans: testTan(7), groups: "gst; TDS/TCS",
    })], ctx());
    expect(v.counts).toEqual({ total: 1, importable: 1, errors: 0, duplicates: 0, warnings: 0 });
    expect(v.ready[0]).toEqual({
      row: 2,
      payload: {
        name: "Kaveri Textiles", client_type: "partnership", pan, previous_reference: "K-9", email: "accounts@example.test",
        mobile: "9845012345", incharge_id: STAFF, group_ids: [GST, TDS],
        registrations: [{ kind: "gstin", number: testGstin(pan) }, { kind: "gstin", number: testGstin(pan, "29") }, { kind: "tan", number: testTan(7) }],
      },
    });
  });

  it("accepts client_type as the stored value or the label, in any case", () => {
    for (const t of ["private_ltd", "Private Ltd", "PRIVATE LTD", "Co-operative", "aop/boi", "HUF"]) {
      const v = validateImportRows([ok(2, { client_type: t })], ctx());
      expect(v.preview[0].issues.filter((i) => i.column === "client_type")).toEqual([]);
    }
    const bad = validateImportRows([ok(2, { client_type: "company" })], ctx());
    expect(bad.preview[0].issues).toContainEqual({ column: "client_type", message: expect.stringMatching(/client type/i) });
  });

  it("reports every problem in plain words with its column, and never echoes PAN/GSTIN/mobile values", () => {
    const v = validateImportRows([ok(5, {
      name: "", client_type: "individual", pan: "ABCDE12345", mobile: "12345", email: "not-an-email",
      incharge_email: "nobody@example.test", gstins: "33ZZZPZ0001Z1Z5", tans: "BAD", groups: "GST;Payrol",
    })], ctx());
    const p = v.preview[0];
    expect(p.status).toBe("error");
    expect(p.row).toBe(5);
    const cols = p.issues.map((i) => i.column);
    for (const c of ["name", "pan", "mobile", "email", "incharge_email", "tans", "groups"]) expect(cols).toContain(c);
    const text = JSON.stringify(p.issues);
    expect(text).not.toMatch(/ABCDE12345|12345|33ZZZ/);
    expect(text).toMatch(/Payrol/); // group names are not PII — say which one is unknown
    expect(v.ready).toEqual([]);
  });

  it("a GSTIN that doesn't contain the row's PAN is an error on the gstins column", () => {
    const v = validateImportRows([ok(2, { pan: testPan("P", 1), gstins: testGstin(testPan("P", 2)) })], ctx());
    expect(v.preview[0].issues).toContainEqual({ column: "gstins", message: expect.stringMatching(/PAN/) });
  });

  it("PAN letter that doesn't fit the type: error for most types, warning (importable) for society", () => {
    expect(validateImportRows([ok(2, { client_type: "individual", pan: testPan("C", 1) })], ctx()).preview[0].status).toBe("error");
    const soc = validateImportRows([ok(2, { client_type: "society", pan: testPan("T", 1) })], ctx());
    expect(soc.preview[0].status).toBe("warning");
    expect(soc.ready).toHaveLength(1);
  });

  it("incharge is required; blank groups use the office's 'Enabled for new clients' defaults", () => {
    const v = validateImportRows([ok(2, { incharge_email: "" }), ok(3)], ctx());
    expect(v.preview[0].issues).toContainEqual({ column: "incharge_email", message: expect.any(String) });
    expect(v.ready[0].payload.group_ids).toEqual([DEFAULT_GROUP]);
  });

  it("cells over 500 characters are rejected (defensive limit)", () => {
    const v = validateImportRows([ok(2, { previous_reference: "x".repeat(501) })], ctx());
    expect(v.preview[0].status).toBe("error");
  });
});

describe("duplicates and warnings (AC-15)", () => {
  it("PAN of an existing active client → Duplicate — skipped (with that client's code)", () => {
    const pan = testPan("P", 9);
    const v = validateImportRows([ok(2, { pan })], ctx({ existingPans: new Map([[pan, "C0042"]]) }));
    expect(v.preview[0].status).toBe("duplicate");
    expect(v.preview[0].issues[0].message).toMatch(/C0042/);
    expect(v.counts).toMatchObject({ importable: 0, duplicates: 1 });
  });

  it("PAN earlier in the same file → later row is Duplicate — skipped (case/space-insensitive)", () => {
    const pan = testPan("P", 10);
    const v = validateImportRows([ok(2, { pan }), ok(3, { pan: ` ${pan.toLowerCase()} ` })], ctx());
    expect(v.preview.map((p) => p.status)).toEqual(["valid", "duplicate"]);
    expect(v.preview[1].issues[0].message).toMatch(/row 2/);
    expect(v.ready.map((r) => r.row)).toEqual([2]);
  });

  it("an earlier row with errors doesn't make a later row a duplicate (only rows that will be imported count)", () => {
    const pan = testPan("P", 11);
    const v = validateImportRows([ok(2, { pan, email: "bad" }), ok(3, { pan })], ctx());
    expect(v.preview.map((p) => p.status)).toEqual(["error", "valid"]);
  });

  it("no PAN but same name as an existing client → warning, still importable", () => {
    const v = validateImportRows([ok(2, { name: "kaveri textiles" })], ctx({ existingNames: new Set(["kaveri textiles"]) }));
    expect(v.preview[0].status).toBe("warning");
    expect(v.preview[0].issues[0].message).toMatch(/same name/i);
    expect(v.ready).toHaveLength(1);
    // With a PAN, the PAN decides (no name warning).
    const withPan = validateImportRows([ok(2, { name: "Kaveri Textiles", pan: testPan("P", 12) })], ctx({ existingNames: new Set(["kaveri textiles"]) }));
    expect(withPan.preview[0].status).toBe("valid");
  });

  it("a GSTIN/TAN already on another client, or used by an earlier row, is an error (the DB would refuse the whole chunk)", () => {
    const pan = testPan("P", 13);
    const v = validateImportRows(
      [ok(2, { tans: testTan(1) }), ok(3, { tans: testTan(1) }), ok(4, { pan, gstins: testGstin(pan) })],
      ctx({ existingRegistrations: new Set([testGstin(pan)]) }),
    );
    expect(v.preview.map((p) => p.status)).toEqual(["valid", "error", "error"]);
    expect(v.preview[1].issues[0].column).toBe("tans");
    expect(v.preview[2].issues[0].column).toBe("gstins");
  });
});

describe("chunks and error file (AC-16)", () => {
  it("splits ready rows into chunks of at most 200, in file order", () => {
    const chunks = chunkRows(Array.from({ length: 450 }, (_, i) => i));
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks[2][0]).toBe(400);
  });

  it("error file = template columns + error column; round-trips through the parser; formula-looking cells are neutralised", () => {
    const rows = [ok(2, { name: "=HYPERLINK(\"x\")", mobile: "+91 98450 12345", email: "bad" }), ok(3)];
    const csv = errorRowsCsv([{ raw: rows[0], reason: "email: Enter a valid email address." }]);
    const table = Papa.parse<string[]>(csv.trim()).data;
    expect(table[0]).toEqual([...IMPORT_COLUMNS, "error"]);
    expect(table).toHaveLength(2);
    expect(table[1][0].startsWith("'=")).toBe(true); // spreadsheet won't run it
    expect(table[1][IMPORT_COLUMNS.length]).toBe("email: Enter a valid email address.");
    const back = parseImportCsv(csv);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.rows[0].cells.name).toBe("=HYPERLINK(\"x\")");
    expect(back.rows[0].cells.mobile).toBe("+91 98450 12345");
  });
});
