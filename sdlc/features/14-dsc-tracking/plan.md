# Plan: DSC tracking
Spec: ./spec.md (approved 2026-10-31, T1–T5) · Status: **approved (Sidambara, 2026-10-31; fixed test-only CI key; 13 ∥ 14 checkpoint approved)** · Date: 2026-10-31
Branch: `feat/14-dsc-tracking` · Locks: none — **additive-only migration exception** (own new objects only, T1; owner approval at this gate) · RUN_SLOW: not needed (no 02/03 write path)

## Files that change
**Migration (new, one file):** `…_dsc.sql`
- enum `dsc_class`; tables `dsc`, `dsc_custody`, `client_dsc_setting` with RLS, checks, column grants (`password_ct` excluded from select), indexes `(office_id, expires_on) where archived_at is null`, `(dsc_id, at desc)`;
- functions: `dsc_save`, `dsc_reveal` (definer, logs then returns), `dsc_custody_log`, `dsc_archive` / `dsc_unarchive`, `dsc_set_remind_days`, `dsc_due`;
- FKs `on delete cascade` to `client` (the test purge deletes clients, so `reset_test_office` stays unchanged; verified at step 1 against its delete order, including `staff_user`);
- test-only `test_seed_dsc` (service role, `is_test` offices only) for the `dsc_due` timing seed.

**Lib:** `src/lib/dsc/crypto.ts` (server-only; the only reader of `DSC_ENC_KEYS` / `DSC_KEY_ID`), `src/lib/dsc/actions.ts` (save, reveal, custody, archive, settings), `src/lib/dsc/queries.ts`, `src/lib/dsc/expiry.ts` (status text), `src/lib/validation/dsc.ts`; `lib/auth/permissions.ts` (+4 rows), `lib/activity-feed/catalogue.ts` (+8), activity filter "Password reveals".

**Screens:** `clients/[id]/page.tsx` (DSC tab), new `clients/[id]/dsc-view.tsx` (list, add/edit dialog, change password, reveal, custody dialog, archived toggle), Client › Settings card (remind days), `today/today-view.tsx` (separate section; data from `dsc_due`), Activity filter.

**Config/docs:** `eslint.config.*` (key fence, same pattern as `BREVO_API_KEY`), `.env.example`, architecture.md (4 items + D5 decision row), ui-reference.md deviation rows (DSC tab and dialogs are new screens), `sdlc/releases/README.md` R1 checklist (key per environment, key backup, weekly reveal check, written risk acceptance).

## New tests (failing first)
- unit: `dsc-crypto.test.ts`, `dsc-validation.test.ts`, `dsc-expiry.test.ts`, catalogue coverage (existing test, picks up new actions).
- RLS: `dsc.test.ts`, `dsc-reveal.test.ts`, `dsc-due.test.ts`; `role-matrix.test.ts` + `permissions.test.ts` (4 rows — **additive** probes, as every feature adds them).
- e2e: `dsc.spec.ts`.

**Existing tests that change:** none (spec AC-14). `role-matrix` / `permissions` gain rows only.

## Steps
- [x] 0. **Setup + checkpoint** (shared with 13): commit this plan; roadmap PR on main (13 + 14 in progress, locks, merge order). — proof: roadmap PR merged
- [x] 1. **Failing tests first** (unit crypto + RLS files). — proof: they fail for the expected reason on dev
- [x] 2. **Crypto module + key fence + env.** Dev key generated and added to dev Vercel (server-only) and `.env.local` by the owner (I give the command; the key never passes through chat). — proof: `dsc-crypto` green; lint fence test
- [x] 3. **Migration.** — proof: RLS files green on dev; md5 = file; schema fingerprint shows only new objects
- [x] 4. **Lib layer** (actions, queries, permissions, sentences). — proof: unit green
- [x] 5. **DSC tab** (list, add/edit, change password, archive). — proof: e2e part locally; axe; 390 px
- [x] 6. **Reveal** (30 s, copy, polite announcement, no-store). — proof: e2e reveal part; `dsc-reveal` RLS
- [x] 7. **Custody log.** — proof: RLS + e2e part
- [x] 8. **Settings + Today section.** — proof: `dsc-due` (incl. timing seed) + e2e part
- [x] 9. **Docs + R1 checklist.** — proof: review
- [ ] 10. **Security review** (separate reviewer agent: crypto, `dsc_reveal`, grants, logs, browser caching) + `sdlc-reviewer`; fix findings failing-first. — proof: no open blocker/important finding
- [ ] 11. **Full verification:** lint, typecheck, unit, full RLS on dev, `dsc.spec` locally; push → PR CI (asked first); Regression `only` = `dsc` (migration rule; asked first) → PR with the AC table. — proof: CI green + AC table

## Risks
- **Key handling:** a lost key makes every stored password unreadable; a leaked key plus a database copy exposes them. Key generated locally by the owner, stored in Vercel + the owner's password manager; never in git, chat, logs or CI.
- **PR CI has no secrets** (ci-speed): e2e on local stacks needs a key. Use a **fixed test-only key** defined in the CI workflow / test env (clearly not a secret, valid only for test data); the app refuses that key ID when `APP_ENV=production`. **Decided 2026-10-31: fixed test-only key.**
- **Merge order with 13:** 14 touches no 13 file except shared additive spots (`permissions.ts`, `role-matrix.test.ts`, the activity catalogue, `today-view.tsx`, client tabs). Whichever merges second merges main in and re-runs the suite.

## Estimate
[Uncertain] 5–7 working days incl. the security review (intent said 6–9; the additive-only scope and Today-only reminders trim it).

## Deviations from plan
- **D-1 (step 1): a ninth activity action, `dsc.remind_days_set`** (entity client, `{client_id, remind_days}`): the spec lists eight, but every mutation writes activity (architecture rule), and the remind-days setting is one. One more sentence in the catalogue.
- **D-2 (step 1): custody dates can't be in the future** (office date, `DATE_IN_FUTURE`), like 13's received-on rule; the spec didn't say.
- **D-4 (step 3, Sidambara 2026-11-01): `dsc_due` timing = round trip < 1 s** (02's clients-list rule), not 300 ms round trip: the session's bare round trip to dev is ~300 ms. The spec's 300 ms stays as the database's own time, recorded here from a server measurement (`explain analyze`).
- **D-5 (step 8): Today's "DSC expiring" card shows only when something is due** (no zero card), and it is a card above the client cards, not a count tile: it has its own data (`dsc_due`) and no rows to filter. `today-view.tsx` gains one optional slot (`dsc`), so its existing tests are unchanged.
- **D-6 (step 4, Sidambara 2026-11-01): two Activity categories, "DSCs" and "Password reveals"**, before Sign-ins. Approved additive edit of `tests/unit/activity-catalogue.test.ts` (the category list gains the two labels; a new test pins Password reveals to reveals only).
- **D-7 (step 5): `dsc.spec.ts` runs with a 120 s per-test budget** (`describe.configure`), like 13's long specs: each test signs in and opens several dialogs against dev.
- **D-3 (step 1): writes only through the `dsc_*` functions** (flag `app.dsc_write`), not plain Staff+ insert/update policies as the spec's data model reads: a direct update could otherwise change the password or the record without its activity row. Same pattern as 07's `document_review` and 04's `expected_doc`.

## Architecture items (to paste into architecture.md at merge; 14 holds no architecture lock)
1. Under **Operational**, a new entry:
   - **DSC tracking (14):** `dsc` (client, holder, class, issuer, token note, expiry, `password_ct`, archive fields) · `dsc_custody` (append-only out / in moves, free-text names) · `client_dsc_setting` (remind days 1–180, default 30). Written only by `dsc_save` / `dsc_custody_log` / `dsc_archive` / `dsc_unarchive` / `dsc_set_remind_days` (invoker; flags `app.dsc_write`, `app.dsc_custody`); no delete except the test purge (FKs cascade from `client`). Select policies use 02's Staff+ short-circuit (`dsc_due` 170 → 24 ms at 1,000 × 3). Holder and custody names are personal data: on the entities only, never in activity.
   - **Today's "DSC expiring"** = `dsc_due(scope)` (invoker, office date): live DSCs of live clients expiring within the client's remind days or expired; Mine = clients I'm incharge of (T3). Its own call; `today_items` untouched (T2).
2. Under **Auth & permissions**, a new entry:
   - **Secrets at rest — application-level encryption (14):** DSC token PINs are encrypted in the server (`src/lib/dsc/crypto.ts`, AES-256-GCM, 12-byte IV, AAD `dsc:<keyId>`, stored as `k<keyId>.<iv>.<tag>.<ct>`) with `DSC_ENC_KEYS` / `DSC_KEY_ID` (server env per environment; ESLint fence: only `crypto.ts` reads them). The key never reaches the database or the browser; the database checks only the ciphertext's shape. Fails closed (no key, unknown key ID, tamper). The public test key (CI, sessions) is refused when `APP_ENV` or `VERCEL_ENV` is production. Rotation: add a key ID, re-encrypt, remove the old one (manual in R1).
   - **Reveal = a definer function that logs before it returns:** `password_ct` is outside the column grant; `dsc_reveal(id)` (tenant first; Staff+, `can_see_client`, not archived) writes `dsc.password_revealed` and returns the ciphertext in the same transaction; the server decrypts and returns the value in the action's POST response only. The first read that is itself an audited action.
3. Permissions matrix: 27 rows (14 adds Add and edit DSCs · Reveal a DSC password · Log DSC custody · Archive a DSC).
4. Decision-log row: | 2026-10-31 | **DSC passwords stored, encrypted in the app (D5, Q3); reveal = Staff, Manager, Admin who can see the client (Q2), every reveal logged in the same call; Limited never**; written risk acceptance by the firm before real passwords on prod; weekly reveal check | Kushal review D5: the firm keeps the PIN with the fob today; a database dump alone must not expose PINs; the reveal log is the detective control for the widest reveal option | 14 |

## Session log
### 2026-10-31
- Intent approved (Q1–Q7; reveal = Staff+, widest option, risk noted). Spec approved (T1–T5). Plan approved.
- **13 ∥ 14 checkpoint (approved):** schema + architecture locks → 13; 14 under the additive-only exception, its architecture items written at its merge; merge order = whichever is green first, the second merges main in and re-runs the suite; shared spots additive only (`permissions.ts`, `role-matrix.test.ts`, activity catalogue, `today-view.tsx`, client tabs). Build order: 13 first, 14 while 13 waits for CI/review.
- **Build started (Sidambara, 31 Oct 23:44).** main (13) merged into the branch. Step 1: `tests/support/dsc.ts` (contract), unit `dsc-crypto` (incl. the ESLint fence), `dsc-validation`, `dsc-expiry`; RLS `dsc`, `dsc-reveal`, `dsc-due` (incl. the 1,000 × 3 timing seed, every run like 02's `clients-list`); additive rows in `permissions.test.ts` and probes in `role-matrix.test.ts`. All fail for the expected reason on dev (missing module / `Could not find the function public.dsc_save`). `reset_test_office` deletes clients, so `on delete cascade` from `dsc` covers the purge with no change to it (checked on dev).
- **Step 2 (code done; dev key pending from the owner):** `src/lib/dsc/crypto.ts` (key ring, `k<id>` prefix, AAD `dsc:<id>`, fail closed, test key refused in production), ESLint fence (`DSC_ENC_KEYS` / `DSC_KEY_ID` only in crypto.ts; the other fences kept), CI e2e env carries the public test key, `.env.example`. `dsc-crypto` 11/11, lint clean. The session's `.env.local` uses the public test key (test data only). Still needed from the owner: a real dev key on dev Vercel (Production + Preview), backed up in the password manager.
- **Step 3 (in progress):** migration `20261101090000_dsc.sql` applied on dev, then three fixes found by the RLS run and applied as dev-only deltas so dev = file: (1) Postgres caps a regex repetition at 255, so `{2,600}` became `{2,}` + `char_length ≤ 700`; (2) `text[] || 'x'` parsed as an array literal → `array_append`; (3) select policies get 02's Staff+ short-circuit (`(select has_role(…)) or can_see_client`) — `dsc_due` spent ~150 of 170 ms on 2,859 `can_see_client` calls. Delta (3) is **not yet on dev**: the Supabase connector asked a confirmation question (it drops and recreates two policies) that timed out. RLS run before (3): 34/36; the two open items were the `array_append` fix (applied since) and the timing (480 ms round trip vs 300; the session's bare round trip to dev is ~300 ms, server time 170 ms).
- **Step 3 done (1 Nov 00:15):** delta (3) applied on dev after the owner approved the connector prompt. `dsc_due` database time at 1,000 clients × 3 DSCs (`explain analyze`, Staff, warm): **170 ms → 24 ms** (Everyone 23.7 ms, Mine 24.2 ms), within the spec's 300 ms. All 11 functions on dev = file (md5 of each body). `dsc`, `dsc-reveal`, `dsc-due` 36/36 on dev; `role-matrix` 128/129: the only failure is the four new probes having no rows yet (`permissions.ts`, step 4), as expected.
- **Dev key set (owner, 1 Nov 00:26):** `DSC_ENC_KEYS` / `DSC_KEY_ID` added to dev Vercel by Sidambara (value generated on the owner's machine; never in chat, git or this session). Not verifiable from the session (no Vercel access); first proof = the deployed-site e2e in the nightly / a Regression dispatch after merge. Step 2 complete.
- **Steps 4–9 (1 Nov, Sidambara: "go step 4 to step 9"):**
  - 4: `validation/dsc.ts`, `dsc/expiry.ts`, `dsc/actions.ts` (encrypt on save / change password; reveal = `dsc_reveal` then decrypt, POST response only; key problems fail closed with one plain message), `dsc/queries.ts` (explicit column lists; `password_ct` never selected), `dsc/messages.ts`; 4 permission rows; 9 sentences; categories "DSCs" + "Password reveals" (D-6). Unit 632/632.
  - 5–8: Client › DSC tab (`dsc-view.tsx`), Reveal (30 s, Copy, Hide, polite live region), custody dialogs + log, Archive / Unarchive, Settings card (`dsc-remind-card.tsx`), Today card (`today/dsc-due-section.tsx`, one optional slot in `today-view.tsx`, D-5). `dsc.spec.ts` 7/7 locally against dev (1.9 min; first run timed out at 30 s on the 390 px reload → 120 s budget, D-7); axe clean on the tab, the reveal state and Today; no horizontal scroll at 390 px.
  - 9: `ui-reference.md` (6 rows), `sdlc/releases/README.md` "DSC passwords" (key per environment, backup, staging round trip, written risk acceptance, weekly reveal check, rotation), architecture items drafted above (pasted at merge).
  - Verification: lint 0, typecheck 0, unit 632/632, `dsc` + `dsc-reveal` + `dsc-due` + `role-matrix` + `activity-feed` 154/154 (1 skipped: RUN_SLOW) on dev.
  - Step 3's "schema fingerprint" proof isn't possible in a session (no Docker); dev = file was checked by md5 of all 11 function bodies, and PR CI's local stacks replay the file from scratch.
