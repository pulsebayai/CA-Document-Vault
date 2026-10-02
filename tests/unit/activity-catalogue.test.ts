import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVITY_CATALOGUE, describeActivity, dayHeading, timeOfDay } from "@/lib/activity-feed/catalogue";
import { ACTIVITY_CATEGORIES, actionsFor } from "@/lib/activity-feed/categories";

// Feature 08 AC-6 — every action string the app or the database writes has a sentence. The scan reads
// src/** and supabase/migrations/**: SQL literals inside `insert into public.activity …;` and TS literals after
// `action:`. Actions built at run time are listed in DYNAMIC with their expansions; a new dynamic form fails the
// test until it is added here (so it can't slip past the catalogue).

const ROOT = process.cwd();
const ACTION = /^[a-z_]+\.[a-z_]+$/;

const DYNAMIC: Record<string, string[]> = {
  // 07 review_document: 'document.' || p_outcome
  "sql:document": ["document.reviewed", "document.needs_correction"],
  // 02 plan actions: `${TABLE[kind]}.paused` / `${TABLE[kind]}.resumed`
  "ts:${TABLE[kind]}.paused": ["client_group.paused", "client_doc_type.paused"],
  "ts:${TABLE[kind]}.resumed": ["client_group.resumed", "client_doc_type.resumed"],
};

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) ? [p] : [];
  });
}

function scan() {
  const found = new Map<string, string>(); // action → first file
  const dynamic = new Set<string>();
  const add = (a: string, f: string) => { if (!found.has(a)) found.set(a, relative(ROOT, f)); };
  for (const f of files(join(ROOT, "supabase", "migrations"), /\.sql$/)) {
    const sql = readFileSync(f, "utf8");
    for (const m of sql.matchAll(/insert into public\.activity\b([\s\S]*?);/gi)) {
      for (const [, a] of m[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)) add(a, f);
      for (const [, prefix] of m[1].matchAll(/'([a-z_]+)\.'\s*\|\|/g)) dynamic.add(`sql:${prefix}`);
    }
  }
  for (const f of files(join(ROOT, "src"), /\.(ts|tsx)$/)) {
    if (f.includes(join("lib", "activity-feed"))) continue; // the catalogue itself
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\baction:\s*([^\n]*)/g)) {
      const expr = m[1];
      const tpl = /^`([^`]*)`/.exec(expr);
      if (tpl) { dynamic.add(`ts:${tpl[1]}`); continue; }
      for (const [, a] of expr.matchAll(/"([a-z_]+\.[a-z_]+)"/g)) add(a, f);
    }
  }
  return { found, dynamic };
}

describe("activity catalogue (AC-6)", () => {
  const { found, dynamic } = scan();

  it("finds the actions written today (sanity: the scan works)", () => {
    for (const a of ["document.added", "auth.signed_in", "dispatch.created", "expected.generated", "reminder.email", "staff.invited"]) {
      expect(found.has(a), a).toBe(true);
    }
    expect(found.size).toBeGreaterThan(30);
  });

  it("knows every dynamic action form", () => {
    expect([...dynamic].filter((d) => !DYNAMIC[d])).toEqual([]);
  });

  it("has a sentence for every action string in src/ and supabase/migrations/", () => {
    const all = new Set([...found.keys(), ...[...dynamic].flatMap((d) => DYNAMIC[d] ?? [])]);
    const missing = [...all].filter((a) => !ACTIVITY_CATALOGUE[a]).map((a) => `${a} (${found.get(a) ?? "dynamic"})`);
    expect(missing).toEqual([]);
  });

  it("every entry is a well-formed action in a known category", () => {
    const cats = new Set(ACTIVITY_CATEGORIES.map((c) => c.id));
    for (const [a, e] of Object.entries(ACTIVITY_CATALOGUE)) {
      expect(a).toMatch(ACTION);
      expect(cats.has(e.category), `${a} → ${e.category}`).toBe(true);
    }
  });

  it("the Sign-ins category holds only sign-ins, and no other category holds them (AC-8)", () => {
    expect(actionsFor("sign_ins")).toEqual(["auth.signed_in"]);
    for (const c of ACTIVITY_CATEGORIES.filter((x) => x.id !== "sign_ins")) {
      expect(actionsFor(c.id)).not.toContain("auth.signed_in");
    }
  });

  it("categories match the spec's filter list, in order", () => {
    expect(ACTIVITY_CATEGORIES.map((c) => c.label)).toEqual([
      "Documents", "Review & dispatch", "Expected", "Reminders", "Clients & plans", "Catalogue", "Users", "Sign-ins",
    ]);
  });
});

describe("sentences (AC-5, AC-6)", () => {
  const row = {
    action: "dispatch.created", actor_name: "Ravi Kumar", client_name: "Rajesh Traders", doc_code: "DOC-FY26-27-00111",
    doc_type_name: "Form 16", doc_group_name: "ROC", data: { method: "courier", document_ids: ["x"] },
  };

  it("reads as '<actor first name> <verb> <object>' with a ' · '-joined detail line", () => {
    const s = describeActivity({ ...row, action: "document.reviewed" });
    expect(s.sentence).toBe("Ravi reviewed Form 16");
    expect(s.detail).toBe("Rajesh Traders · ROC · DOC-FY26-27-00111");
  });

  it("system rows read 'Vault'", () => {
    const s = describeActivity({ ...row, action: "expected.generated", actor_name: null, client_name: null, doc_code: null,
      doc_type_name: null, doc_group_name: null, data: { created: 120, linked: 3 } });
    expect(s.sentence).toBe("Vault generated 120 expected items");
  });

  it("an unknown action still renders", () => {
    const s = describeActivity({ ...row, action: "doc_type.something", client_name: null, doc_code: null, doc_type_name: null, doc_group_name: null, data: {} });
    expect(s.sentence).toBe("Ravi · doc_type.something");
  });

  it("names a client or type it can't see as hidden, never blank", () => {
    const s = describeActivity({ ...row, action: "document.reviewed", doc_type_name: null, client_name: null });
    expect(s.sentence).toBe("Ravi reviewed a document");
    expect(s.detail).toBe("ROC · DOC-FY26-27-00111");
  });
});

describe("day headings and times in IST (AC-5)", () => {
  const now = new Date("2026-10-02T06:00:00Z"); // 2 Oct, 11:30 IST
  it("Today / Yesterday / weekday, day month", () => {
    expect(dayHeading("2026-10-01T18:45:00Z", now)).toBe("Today, 2 October"); // 00:15 IST on 2 Oct
    expect(dayHeading("2026-10-01T18:29:00Z", now)).toBe("Yesterday, 1 October");
    expect(dayHeading("2026-09-28T06:00:00Z", now)).toBe("Monday, 28 September");
  });
  it("time is HH:MM in IST", () => {
    expect(timeOfDay("2026-10-01T18:45:00Z")).toBe("00:15");
    expect(timeOfDay("2026-10-02T09:05:00Z")).toBe("14:35");
  });
});
