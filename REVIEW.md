# Review instructions — CA Document Vault
Three passes on every PR. Rank findings **Important** (must fix before merge) or **Nit**. Skip what CI enforces (lint, types, formatting).

## 1. Bugs
- Logic errors, edge cases (empty lists, first/last item, concurrent edits), regressions against spec ACs.
- Server actions: validate input with zod; return friendly errors; never trust IDs or office from the browser.

## 2. Security (this app holds clients' PAN, GSTIN, bank statements)
- Every new table: `office_id`, RLS enabled, default deny, policies scoped by `private.current_office_id()`. Missing RLS = Important.
- Service-role client (`@/lib/supabase/admin`) used only in allow-listed server modules; never in client components; `SUPABASE_SECRET_KEY` never `NEXT_PUBLIC_`.
- No PII (PAN, GSTIN, mobile, email, client names) in URLs, logs, analytics or activity `data`.
- No hard deletes; archive. Audit (`activity`) written for every state change.
- Files: private bucket, short-lived signed URLs, type/size allow-list.
- Data stays in ap-south-1 / bom1; no new third-party services without an architecture.md decision.

## 3. Compliance
- Matches the feature's spec.md ACs and plan.md "Files that change"; no unrequested refactors.
- Follows architecture.md (dimensions, derived group/FY, expected vs received) and ui-reference.md (tokens, agreed deviations; WCAG AA wins).
- Migrations only from the feature holding the schema lock; staging rehearsal before prod.
