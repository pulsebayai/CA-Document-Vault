// Feature 18 (spec X2, AC-2, AC-11): every table, view and function the database has, with the cross-firm case that
// proves Firm A's staff can't reach Firm B through it — or an exemption with a written reason. guard.test.ts compares
// this map with public.test_schema_inventory() and fails on any difference, like 08's permission matrix.
//
// Adding a table, view or function? Add its line here (and its case in the matching test file) in the same PR.

/** A case is named by the test that proves it: "<file>:<case>", e.g. "tables:read". */
export type Coverage =
  | { cases: string[] } // tested directly by these cases
  | { via: string[] } // a private definer reached only through these public objects' cases (AC-11)
  | { exempt: string }; // why no cross-firm case applies (a reason is required)

/** Key = table or view name in public. */
export const TABLES: Record<string, Coverage> = {};

/** Key = "<schema>.<name>(<identity args>)", exactly as pg_get_function_identity_arguments prints them. */
export const FUNCTIONS: Record<string, Coverage> = {};
