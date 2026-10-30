// Feature 12, spec AC-1 … AC-5 (decision D4): the type-ahead Document type field. Pure and synchronous: the form
// passes the types it already loads (the client's plan types + the office's approved types), so typing never waits
// for the server. Tested in tests/unit/type-match.test.ts.

export type TypeOption = {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  groupSort: number;
  frequency: string;
  /** In this client's collection plan (shown first, under its group heading). */
  inPlan: boolean;
  /** A staff-proposed type waiting for a decision (05): the field says "Proposed". */
  proposed: boolean;
  /** Old/new form names (02), e.g. Form 16 ↔ Form 130. */
  aliases: string[];
};

export type TypeSection = { kind: "group" | "other"; heading: string; rows: { type: TypeOption }[] };

export type TypeMatch = {
  sections: TypeSection[];
  /** Matches not shown because of the row limit. */
  more: number;
  /** Nothing matched the text. */
  noMatch: boolean;
  /** When nothing matched: up to 3 types sharing a word of 3+ letters (plan types first). */
  close: TypeOption[];
  /** Empty field and no plan types (e.g. no client yet): ask the user to type to search all types. */
  searchAll: boolean;
};

/** D4: the heading over types that aren't in this client's plan. */
export const OTHER_TYPES_HEADING = "Not in existing category plan";
const LIMIT = 8;
const CLOSE_LIMIT = 3;

/** Lower case without spaces, hyphens, dots, slashes or underscores: "GSTR-3B" = "gstr 3b" = "gstr3b". */
export const normaliseTypeText = (s: string) => s.toLowerCase().replace(/[\s\-./_]+/g, "");

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

const byName = (a: TypeOption, b: TypeOption) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
const byGroupThenName = (a: TypeOption, b: TypeOption) => a.groupSort - b.groupSort || a.groupName.localeCompare(b.groupName) || byName(a, b);

export function matchTypes(types: TypeOption[], text: string, opts: { limit?: number } = {}): TypeMatch {
  const limit = opts.limit ?? LIMIT;
  const q = normaliseTypeText(text);

  // AC-1: an empty field lists the client's plan types only.
  if (!q) {
    const plan = types.filter((t) => t.inPlan).sort(byGroupThenName);
    if (plan.length === 0) return { sections: [], more: 0, noMatch: false, close: [], searchAll: true };
    return { ...build(plan.map((type) => ({ type, rank: 0 })), limit), noMatch: false, close: [], searchAll: false };
  }

  // AC-2/AC-3: name, aliases or group name contain the text; a name that starts with it ranks first.
  const hits: { type: TypeOption; rank: number }[] = [];
  for (const type of types) {
    const name = normaliseTypeText(type.name);
    if (name.startsWith(q)) hits.push({ type, rank: 0 });
    else if (name.includes(q) || type.aliases.some((a) => normaliseTypeText(a).includes(q)) || normaliseTypeText(type.groupName).includes(q)) {
      hits.push({ type, rank: 1 });
    }
  }
  if (hits.length > 0) return { ...build(hits, limit), noMatch: false, close: [], searchAll: false };

  // AC-5: nothing matched — offer up to 3 types that share a word of 3+ letters, plan types first.
  const qWords = words(text);
  const close = qWords.size === 0 ? [] : types
    .filter((t) => [t.name, ...t.aliases].some((s) => [...words(s)].some((w) => qWords.has(w))))
    .sort((a, b) => Number(b.inPlan) - Number(a.inPlan) || byGroupThenName(a, b))
    .slice(0, CLOSE_LIMIT);
  return { sections: [], more: 0, noMatch: true, close, searchAll: false };
}

/** Plan types under their group headings (catalogue order), then the rest under one heading; at most `limit` rows. */
function build(hits: { type: TypeOption; rank: number }[], limit: number): Pick<TypeMatch, "sections" | "more"> {
  const order = (a: { type: TypeOption; rank: number }, b: { type: TypeOption; rank: number }) => a.rank - b.rank || byName(a.type, b.type);
  const groups = new Map<string, { sort: number; name: string; rows: { type: TypeOption; rank: number }[] }>();
  const other: { type: TypeOption; rank: number }[] = [];
  for (const h of hits) {
    if (!h.type.inPlan) { other.push(h); continue; }
    const g = groups.get(h.type.groupId) ?? { sort: h.type.groupSort, name: h.type.groupName, rows: [] };
    g.rows.push(h);
    groups.set(h.type.groupId, g);
  }
  const ordered: TypeSection[] = [...groups.values()]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((g) => ({ kind: "group" as const, heading: g.name, rows: g.rows.sort(order).map(({ type }) => ({ type })) }));
  if (other.length) {
    other.sort((a, b) => a.rank - b.rank || byGroupThenName(a.type, b.type));
    ordered.push({ kind: "other", heading: OTHER_TYPES_HEADING, rows: other.map(({ type }) => ({ type })) });
  }

  let left = limit;
  const sections: TypeSection[] = [];
  for (const s of ordered) {
    if (left <= 0) break;
    const rows = s.rows.slice(0, left);
    left -= rows.length;
    sections.push({ ...s, rows });
  }
  return { sections, more: Math.max(0, hits.length - limit) };
}
