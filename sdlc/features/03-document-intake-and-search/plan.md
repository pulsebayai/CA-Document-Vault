# Plan: Document intake
Spec: ./spec.md · Status: approved (Raja 2026-09-28) · Date: 2026-09-28
Holds: **schema lock** + **architecture lock** (spec's 4 approved changes; applied to architecture.md in this feature's PR, as in 02 D5).
Base: `feat/03-document-intake-and-search` from main `ede18ee` (02 merged). PR #6 (roadmap, docs only) merges independently.

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_documents.sql | new | enums, `doc_counter`, `document`, `document_version`, `doc_type.proposed_for_client_id`, triggers (tenant-first, period/registration rules, archive role, append-only versions, forbid_delete), RLS, indexes, SQL functions, `documents` bucket, `reset_test_office` extension |
| src/lib/validation/document.ts | new | file rules (size, extension ↔ type allow-list), file-name sanitiser, received-as/channel lists, received-on rules |
| src/lib/documents/period.ts | new | default period for a frequency + date (IST, FY quarters), DOC-ID formatting / FY of a date |
| src/lib/documents/{queries,actions}.ts | new | list (client, inbox), get, save/classify/update/version/archive, file links, type suggestions, proposed type |
| src/lib/documents/storage.ts | new | server-only: signed upload URL, object verification, signed view/download URL (service role, via `createAdminClient`) |
| src/lib/supabase/admin.ts | mod | doc comment: storage signing/verification added to the allowed uses |
| src/app/(app)/documents/new/page.tsx, document-form.tsx | new | Add document (mockup 12), reused for Inbox "Assign" |
| src/app/(app)/documents/[id]/page.tsx (+ loading/error) | new | document page: details, current file View/Download, versions, edit, new version, archive |
| src/app/(app)/inbox/page.tsx, inbox-view.tsx (+ loading/error) | new | Inbox (mockup 02) |
| src/app/(app)/clients/[id]/page.tsx, documents-view.tsx | mod/new | Documents tab + "Add document" button (mockup 10, received only) |
| src/app/(app)/clients/[id]/plan-view.tsx | mod | "Proposed" badge on proposed plan types |
| src/app/(app)/settings/catalogue/catalogue-view.tsx, page.tsx | mod | read-only "Proposed by staff" panel (mockup 05) |
| src/components/app-header.tsx | mod | "Inbox" nav item with count, "+ Add document" button |
| tests/rls/{documents,document-storage,proposed-types}.test.ts | new | DB/RLS + storage tests (written first) |
| tests/unit/{document-rules,document-period}.test.ts, tests/unit/document-form.test.tsx | new | validators, period defaults, form behaviour |
| tests/e2e/{add-document,inbox,client-documents}.spec.ts | new | e2e per spec + axe; screenshots.spec extended for 02/10/12 |
| tests/support/{documents,catalogue}.ts | new/mod | fixtures: tiny synthetic files, storage cleanup for test offices before `reset_test_office` |
| sdlc/product/architecture.md | mod | 4 approved changes + cross-cutting decisions (in the PR, like 02 D5) |

## Migrations (schema lock: 03)
1. `20260928105415_documents.sql` (+ `20260928105446_doc_type_insert_policy.sql` and `20260928105505_doc_type_insert_policy_initplan.sql`, advisor fixes: one doc_type INSERT policy, current_setting evaluated once) — everything above in one additive migration. SQL functions (SECURITY INVOKER unless noted — RLS applies):
   - `private.next_doc_code(office, fy_code)` — **definer**, row lock on `doc_counter`, returns `DOC-FY26-27-NNNNN` (implemented inside the document insert trigger).
   - `public.create_document(jsonb)` — document (+ version when a file is given) + activity, atomic; soft copy requires a file; sets `classified_at` when client + type are present.
   - `public.add_document_version(uuid, jsonb)` — next version number, becomes current, activity.
   - `public.classify_document(uuid, jsonb)` / updates — `classified_at` set once; one activity row.
   - `public.create_proposed_type(client, group, name)` — proposed `doc_type` + `client_doc_type` (as needed) + client-only `client_group` row when the group isn't enabled; one activity row.
   - `public.suggest_doc_types(client, query)` — trigram over name + aliases (approved active types + the client's own proposed types).
   - `documents` bucket: `insert into storage.buckets` (private, 25 MB, MIME allow-list). No `storage.objects` policies for app roles.
   Dry-run on dev inside a rolled-back block (impersonating admin/staff/limited), apply, advisors; saved under the version `list_migrations` shows. Staging/prod at R1.

## Steps (estimates = build sessions with Claude; your time in brackets)
- [x] 0. Baseline: branch green in CI on 02's merged main — proof: CI run on the branch (docs-only commits so far) [—]
- [x] 1. RLS/DB tests first (red): visibility matrix (4 roles × assigned/not × classified/inbox × own/others'); DOC-ID sequence per FY + restart 1 April (fixed dates) + no gaps + never reused; soft copy needs a file; version append-only, new version becomes current; archive Admin/Manager; DELETE rejected; `classified_at` once; registration/period rules; proposed type → plan row (+ client-only group row); suggestions fuzzy + aliases; activity without file names/remarks/PII; storage bucket private (anon + signed-in user can't read/list) — proof: `test:db` fails for the right reasons (1)
- [x] 2. Migration written, dry-run, reviewed, applied to dev; advisors clean — proof: step-1 tests green in CI (1) [review SQL: 30–45 min]
- [x] 3. Shared rules: file validator + sanitiser, period default (month/quarter/year, April and quarter boundaries), DOC-ID/FY helpers — proof: unit tests red → green (0.5)
- [x] 4. Storage plumbing: `startUpload` (signed upload URL), object verification, `getFileLink` (≤ 60 s signed URL, download name), test cleanup helper — proof: DB/storage test uploads a synthetic PDF via signed URL, registers it, downloads via signed link, link expires; unauthorised lookup gets no link (1)
- [x] 5. Add document screen + header "+ Add document": received as, drop zone/progress, client, type with plan-first list + suggestions + "+ New type", period default, registration, channel, received on, remark, Save to vault / Save to inbox — proof: e2e add from client page (soft copy) + hard copy without file + new proposed type; ≤ 3 clicks path asserted (1.5)
- [x] 6. Inbox + Assign + nav count — proof: e2e save to inbox → Assign → gone from Inbox, `classified_at` set; Limited sees only own Inbox items (1)
- [x] 7. Client › Documents tab + document page (current file View/Download, versions, edit, new version, archive) — proof: e2e new version keeps DOC-ID and becomes current; manager archives; Limited Not Found on another client's document (1.5)
- [x] 8. Catalogue "Proposed by staff" panel + "Proposed" badge in Client › Settings — proof: e2e staff proposes a type → admin sees it in the panel with proposer/client/document count (0.5)
- [x] 9. States + a11y + screenshots vs mockups 02/10/12 + ≤ 390 px — proof: axe 0 serious/critical on 4 new screens; screenshots in the evidence artifact (0.5)
- [x] 10. (provisional — Admin, 1 document; Staff re-time on the R1 staging checklist) AC-5 timed manual check with a **Staff-role** user (≤ 3 clicks after choosing the file, ≤ 30 s median over 3 documents) — proof: times recorded in the PR [you or a staff member: 10 min]
- [ ] 11. (all done except PR ready — waits for step 10 + hardening-SQL review) architecture.md update · `verifier` → `sdlc-reviewer` → fix Important → PR with AC → test → result table — proof: CI green, evidence with all suites [PR review: 1–2 h]
**Total ≈ 9.5 build sessions** (02 took ~10 for similar surface: ~2 working days elapsed at 02's pace). Your review ≈ 3–4 h. First cut if it slips: the per-registration pick (default to "none" and edit later) and the document-page activity summary.

## Risks
| Risk | Mitigation |
|---|---|
| Storage access bypassing RLS | no object policies for app roles; every link issued server-side after an RLS lookup of `document`; test: anon/user can't read or list the bucket |
| Service-role key misuse | only `createAdminClient` (ESLint-enforced), called only from `src/lib/documents/storage.ts` (server-only), after `requireStaff` + RLS lookup |
| Orphan objects (upload ok, save fails) | harmless + private; object path under a fresh UUID; cleanup job before pilot month 2 (tracked in roadmap "Before pilot") |
| Upload verification spoofed (client says 1 MB, uploads 25 MB, or a different path) | server issues the path; verification reads size/MIME from Storage, not from the client; bucket limits as backstop |
| DOC-ID gaps/duplicates under concurrency | counter row lock inside the insert transaction (same pattern as client codes, proven in 02) |
| Storage writes from CI to dev | tiny synthetic files; test offices' objects removed via Storage API at run start |
| Large-file e2e flakiness | e2e uses small files; the 25 MB limit is tested with a size check (bucket rejects > 25 MB) at DB/storage level, not a real 25 MB upload |
| Proposed type creating a partial group | explicit, tested rule (group row holds only the proposed type); Client › Settings shows it; "+ Add type" adds the rest |
| Downloaded files cached by the browser on shared office PCs | uploads stored `Cache-Control: private, no-store`; **Supabase signed downloads don't echo it** (no Cache-Control header, CI 36430717826), so browsers may cache heuristically → before pilot: check the prod/staging response headers; if still absent, serve downloads through a short server route that sets `no-store`, or accept and brief staff (log off shared PCs) |
Rollback: dev only → revert PR + compensating migration (drop new tables/bucket — no real data).

## Proof of done
AC-1…17 → test file → result table in the PR; CI green (Unit + RLS + E2E evidence); screenshots vs mockups 02/10/12; AC-5 times recorded (Staff user); architecture.md updated with the 4 approved changes.

## Deviations from plan
- **Step 1 (2026-09-28) — SQL contract fixed by the tests** (`tests/rls/{documents,proposed-types,document-storage}.test.ts`), approved by Raja 2026-09-28 15:56 IST:
  - **D1 The database reads the file's size and MIME type from Storage** (`storage.objects`, via a definer helper), not from the caller, and rejects a missing object (`OBJECT_MISSING`). Reason: `create_document` / `add_document_version` are callable directly through the API with a user's session, so server-side verification alone could be bypassed. The server still checks before calling (better error messages).
  - **D2 The document ID is the folder UUID in the storage path** (`office/<office>/doc/<document_id>/<version_id>.<ext>`). A version's object must sit under its own document's folder, and the path must hold this office's ID and an allowed extension (`PATH`).
  - **D3 One `update_document(id, jsonb)`** covers classify and edit (only the keys present change). The activity action is `document.classified` when client/type change and `document.updated` otherwise (`fields` = names only). `archive_document(id, reason)` / `unarchive_document(id)` are separate. An archived document can't be edited or given a version (`ARCHIVED`).
  - **D4 Fixed-date DOC-ID tests:** `create_document` accepts `test_added_at` **only in `is_test` offices** (`TEST_ONLY` elsewhere) — same fence as `reset_test_office`.
  - **D5 Limited users can't create proposed types** (it changes a collection plan — 02 rule); Staff, Manager and Admin can. Limited users save to the Inbox and a Staff+ user classifies.
  - **D6 Proposed-type names are unique per (group, client)**, not per group: two clients may propose the same name independently (05 merges them); a name equal to an approved type in the group is refused (`DUPLICATE_TYPE`). Replaces 02's unique index `doc_type_name_key` with two partial ones.
  - **D7 DOC-ID format `DOC-FY26-27-00001`** (was `DOC-26-00001`; Raja 2026-09-28 16:17, before the migration was applied): the FY is written in full so a document added in Feb 2027 doesn't read as "2026". Same numbering rule; no date/time in the ID. Spec rev 2.1, intent, tests and migration changed together; roadmap row text updated at merge (main only).
  - **D8 Declared file type (AC-2):** the extension must be allow-listed and a declared type, when present, must be one browsers use for that extension (e.g. Windows' `application/x-zip-compressed`, Excel-owned `.csv` as `application/vnd.ms-excel`, `image/heif`). An **empty** declared type is accepted — many systems send none for HEIC/CSV/Office files — because the stored type is set by us from the extension and checked again by the bucket and the DB.
  - **Step 4/5 — browser upload is a raw XHR PUT** to the signed upload URL with our canonical Content-Type (progress bar); supabase-js `uploadToSignedUrl` wraps a browser `File` in FormData, which would store the browser's declared type (e.g. `application/x-zip-compressed`) and fail the DB's FILE_TYPE check. Storage logic lives in `storage-core.ts` (client passed in, testable) behind `storage.ts` (server-only, service role, ESLint allow-list).
  - **UI token `--warn` darkened** #B0611A → #9C5717 (4.06:1 → 4.89:1 on `--warn-soft`; first used for text in 03's Hard copy badge; axe caught it). Flag for `references/ui-reference.md` "Agreed deviations" at merge (product doc, main).
  - **Pre-PR review (sdlc-reviewer, step 11) — 6 Important fixed:** migration `20260928134130_documents_hardening` (tenant boundary first in the definer triggers; documents/versions written only through the functions via `app.doc_write`, so activity is never skipped; a filed document can't lose client/type (`DECLASSIFY`); no filing to archived clients; archive needs a reason (check); no bidi/format characters in file names; proposed types only via `create_proposed_type`, proposer = caller, for Admin/Manager too) · Limited users' Inbox/badge = items they added · uploads stored `Cache-Control: private, no-store` · visible keyboard focus on both file pickers. Nits fixed: "+ New type" only after suggestions return; Inbox row aria-label; quieter upload announcements; stricter path check before service-role calls; test purge refuses non-test offices; "saved" banner on the document page. Nits left for later (noted): unarchive clears the reason (activity keeps the event); client picker is a list of buttons, not a full ARIA combobox; proposed-type document counts via `.in()` (fine at pilot scale; count view if it grows); a proposed type added to a *paused* group is active (intended: the client's own new type).
  - **Scope (files beyond "Files that change"):** `selects.ts`, `upload-client.ts`, `storage-core.ts`, `file-buttons.tsx`, `documents/[id]/{document-controls,page}.tsx`, `documents/[id]/assign/*`, `nav-link.tsx`, `(app)/layout.tsx` (Inbox count), `clients/page.tsx` (saved banner), `catalogue/queries.ts`, `plan/queries.ts`, `eslint.config.mjs`, new e2e files `proposed-types.spec.ts` and `document-screenshots.spec.ts` (instead of extending 02's `screenshots.spec.ts`, left untouched), `documents-perf.test.ts`. `tests/unit/document-form.test.tsx` not written: the form is covered by e2e (add/assign/new type/errors/axe/390 px).
  - **Header rework** (office name hidden below md, nav scrolls) for 390 px — flag for ui-reference "Agreed deviations" at merge, with `--warn`.
  - Canonical MIME list (bucket allow-list): the server maps each extension to one type (e.g. Windows' `application/x-zip-compressed` → `application/zip`).

## Session log
### 2026-09-28
- Done: roadmap PRs #5 (02 shipped) and #6 (03 started, split 03 → 03 intake + 03b search, locks → 03); intent approved (rev 2); spec approved (rev 2: proposed types join the client plan; "Proposed by staff" panel; current-version View/Download). Plan drafted.
- In progress: plan gate.
- Blocked / failing: none. AC-17 of 02 (first nightly on main) still to check.
- Next step: plan approval → step 0/1.
- Decisions made (cross-cutting → architecture.md in this PR): signed-URL upload path; DOC-ID per FY of the date added; proposed types join the client plan (client-only group row when needed); received as incl. original; channel list; file allow-list incl. XLS/CSV/HEIC; no malware scan (accepted risk).

### 2026-09-28 (plan approved, step 0)
- Done: plan approved (Raja 14:53 IST). Draft PR #7 opened so CI runs on the branch. **Step 0 proof: CI run 36403195038 (ca490c4) green — unit/lint/typecheck/build · RLS · E2E 25 / 0.**
- In progress: —
- Blocked / failing: none. PR #6 (roadmap: 03 started, split, locks → 03) still open — Raja to merge.
- Next step: step 1 — RLS/DB tests first (red) for documents, DOC-IDs, storage, proposed types. Check 02's AC-17 nightly first.
- Decisions made: none new.

### 2026-09-28 (step 1)
- Done: merged main (roadmap PR #6, docs only) into the branch. **Step 1: 3 new DB test files + `tests/support/documents.ts`** (storage purge before `reset_test_office`, tiny synthetic files). **Proof: CI run 36406058034 (331de9c) — RLS: 51 failed / 86 passed / 15 skipped; every failure is a missing `create_document` / `doc_counter` / `document` / `suggest_doc_types` / `create_proposed_type` or "Bucket not found"; all 8 existing 02 suites green.** Two new tests already pass (staff can't insert catalogue types directly; `reset_test_office` service-role only) — kept as locks.
- In progress: —
- Blocked / failing: 02 AC-17 still unproven — both nightlies so far ran on 581c64d (before the 02 merge); first nightly with it ≈ 04:10 IST 29 Sep. Check first next session.
- Next step: Raja confirms D5 (and D1–D6 in general) → step 2 migration (dry-run on dev → Raja reviews SQL → apply).
- Decisions made (cross-cutting → architecture.md in this PR): D1 (DB verifies stored objects), D4 (test-only clock fenced by is_test).

### 2026-09-28 (step 2)
- Done: D1–D6 approved (Raja 15:56; D5 = Staff/Manager/Admin propose, Limited don't). **D7: DOC-ID format → `DOC-FY26-27-00001`** (Raja 16:14–16:17; spec rev 2.1; no date/time in the ID). Migration dry-run on dev (rolled back) → SQL approved (Raja 16:22) → applied: `20260928105415_documents`, then advisor fixes `20260928105446_doc_type_insert_policy`, `20260928105505_doc_type_insert_policy_initplan` (one INSERT policy on doc_type; 0 WARN left — only "unused index" INFO on new tables and the intended no-policy INFO on `doc_counter`). **Proof: CI run 36412554540 (41aa696) green — Unit 137/0 · RLS 151/0/1 skipped (RUN_SLOW import) · E2E 25/0.** All 51 step-1 failures now pass; 02 suites unchanged.
- In progress: —
- Blocked / failing: 02 AC-17 still waits for tonight's nightly (≈ 04:10 IST 29 Sep).
- Next step: step 3 — shared rules (file validator + sanitiser + extension→MIME map mirroring `private.mime_for_extension`, period default, DOC-ID/FY helpers), unit tests first.
- Notes for later steps: step 8 must filter `status = 'proposed'` out of the catalogue type lists (`src/lib/catalogue/queries.ts`); roadmap row text still says `DOC-YY-NNNNN` → fix at merge (main). Decisions for architecture.md (in this PR): D1 (DB verifies stored objects), D4 (test-only clock fenced by is_test), D7 (DOC-ID format).

### 2026-09-28 (steps 3–9)
- Done: step 3 (validators, sanitiser, period/DOC-ID helpers; unit red → green) · step 4 (storage-core/storage, signed upload tickets, object verification, ≤ 60 s links; CI 36415781400) · step 5 (Add document) · step 6 (Inbox, Assign, nav count) · step 7 (Client › Documents, document page) · step 8 (Proposed by staff panel, Proposed badge) · step 9 (screenshots 02/10/12 + document page, axe, 390 px; nightly volume test for the two lists). **Proof: CI run 36424210171 (30b2ab2) green — Unit 164 · RLS 158/0/3 skipped (RUN_SLOW: 02 import + 03 volume ×2) · E2E 43/0; screenshots in the test-evidence artifact.**
- Fixed on the way (all caught by CI): header overflowed 390 px (02 screenshots test) → nav scrolls, office name hidden on phones; my step-6 "inbox saves go to /inbox" contradicted AC-4 → reverted, header button passes `from`; Inbox badge accessible name; `--warn` contrast 4.06 → 4.89:1; three test-side corrections to tests that had never passed (RFC 6266 filename*, popup race, headless PDF viewer).
- In progress: step 11 (architecture.md, reviewer, PR description).
- Blocked / needs Raja: **step 10 — AC-5 timed check by a Staff-role user** (≤ 3 clicks after choosing the file, median ≤ 30 s over 3 documents) on the Vercel preview. **03 volume test (RUN_SLOW) has not run yet** — first nightly after merge, or a manual `regression.yml` run on this branch.
- Next step: step 11, then Raja: step 10 + PR review.
- Decisions made (→ architecture.md in this PR): D1, D2, D4, D7, D8, raw-PUT upload, `--warn` token (→ ui-reference at merge).

### 2026-09-28 (step 11, evening)
- Done: architecture.md updated (lock 03). `sdlc-reviewer`: 6 Important + 13 Nits → all Important and most Nits fixed (migration `20260928134130_documents_hardening` applied to dev, smoke-checked in a rolled-back block; app fixes). PR #7 description written (AC → test → result table), still **draft**. **Proof: CI run 36432646755 (8a487dd) green — Unit 165 · RLS 164/0/3 skipped · E2E 43/0.**
- In progress: step 11 closes when Raja has reviewed the hardening SQL and step 10 is recorded.
- Blocked / needs Raja: **step 10** (AC-5 timed check with a Staff-role user on the Vercel preview); **review `20260928134130_documents_hardening.sql`**; optional manual `regression.yml` (RUN_SLOW) on this branch for the volume test.
- Residual risk logged: Supabase signed downloads don't send our `no-store` → check on staging before pilot.
- Next step: Raja → step 10 + SQL review → mark PR ready → merge (Raja) → on main: roadmap (03 shipped, DOC-ID text, release locks), ui-reference deviations (`--warn`, phone header).
- Decisions made: none new beyond the review fixes (recorded under Deviations).

### 2026-09-28 (step 10)
- Done: **AC-5 timed check on the Vercel preview by Raja (Admin role — the office has no Staff user yet): 1 document, 15 s** from choosing the file to "saved" (target ≤ 30 s median). Stored as expected: DOC-FY26-27-00001, soft copy, Sales invoices / sales register, period Aug 2026 (the default — the month that just ended), PDF version 1, filed at once, 1 activity row; GSTIN blank because the client has no registration (auto-pick needs exactly one). Clicks after choosing the file were not counted by hand; the flow needs 3 (type ×2, Save) and `add-document.spec.ts` asserts it.
- Decision: accepted as **provisional** (Admin, n = 1). The Add document path is identical for Admin and Staff. **R1 staging checklist: re-time with a Staff-role user, 3 documents, median** (same treatment as 02 AC-22) — roadmap update at merge.
- Next: Raja reviews `20260928134130_documents_hardening.sql` and runs `regression.yml` on this branch (base_url = preview) → PR ready.
