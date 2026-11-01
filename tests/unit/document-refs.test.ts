// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_REF_ACTIONS } from "@/lib/activity-feed/document-refs";

// Feature 15 (spec risk 2, architecture rule "activity of a document = a UNION of indexed lookups per reference
// kind"). A document's history finds rows by entity (entity_type 'document'), by `data.document_id` and by
// `data.document_ids`. This test lists every activity insert in the migrations whose data names a document under one
// of those two keys, and fails when a new action does: whoever adds one must check that 15's indexed lookups (and
// `document_last_activity`) cover it, then add it to DOCUMENT_REF_ACTIONS. It also fails on any other key that looks
// like a document reference (`doc_id`, `documentId`, …), which no lookup would find.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Every `insert into public.activity … ;` statement, with its file. */
function activityInserts(): Array<{ file: string; sql: string }> {
  const out: Array<{ file: string; sql: string }> = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
    const re = /insert\s+into\s+public\.activity\b[\s\S]*?;/gi;
    for (const m of text.matchAll(re)) out.push({ file, sql: m[0] });
  }
  return out;
}

const actionsIn = (sql: string) => [...sql.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);

describe("activity rows that name a document in their data (spec risk 2)", () => {
  const inserts = activityInserts();

  it("finds the activity inserts (sanity)", () => {
    expect(inserts.length).toBeGreaterThan(30);
  });

  it("every action that stores document_id / document_ids is a known reference action", () => {
    const found = new Set<string>();
    for (const { sql } of inserts) {
      if (/'document_ids?'/.test(sql)) for (const a of actionsIn(sql)) found.add(a);
    }
    expect([...found].filter((a) => !DOCUMENT_REF_ACTIONS.includes(a)).sort()).toEqual([]);
    expect(DOCUMENT_REF_ACTIONS.filter((a) => !found.has(a))).toEqual([]); // the list stays exact
  });

  it("no activity insert uses another key for a document", () => {
    const odd = inserts.filter(({ sql }) => /'(doc_id|documentid|document_uuid|doc_ids)'/i.test(sql)).map((i) => i.file);
    expect(odd).toEqual([]);
  });
});
