# Spec: DSC tracking — digital signature certificates under each client
Intent: ./intent.md (approved 2026-10-31) · Status: **approved (Sidambara, 2026-10-31; T1–T5 as recommended)** · Date: 2026-10-31
Screens: no mockup screen (new). Client page tabs (mockup 10–11), Client › Settings (11), Today (01), Activity (04); `ui-reference.md` tokens and components.

## Decisions taken into this spec (confirm at this gate)
| # | Question | Answer in this spec |
|---|---|---|
| T1 | Where the expiry setting lives | A new table `client_dsc_setting` (client → remind days, default 30), **not a new column on `client`**. That keeps 14 inside the **additive-only migration exception** (its own new objects only), so it can build in parallel with 13, which holds the schema lock. |
| T2 | Today | A **separate "DSC expiring" section** fed by its own invoker function `dsc_due(scope)`, **not** a change to `today_items`. 13 replaces `today_items` too, and it is a known slow query (K3). |
| T3 | Reminder owner (intent Q7) | DSCs have no plan row or group, so 06's effective assignee reduces to the **client's incharge**. "Mine" = DSCs of clients I am incharge of. |
| T4 | Who does what | **Add / edit / renew / log custody:** Staff, Manager, Admin; Limited only logs custody (given / received) for clients they can see. **Reveal:** Staff, Manager, Admin (Q2); Limited never. **Archive / unarchive:** Admin/Manager (like documents). |
| T5 | Reveal log | Each reveal writes an activity row **inside the same database call that returns the encrypted value**, so a reveal can't happen without its log. The Activity screen gets a "Password reveals" filter; the R1 checklist adds a weekly look by Admin/Manager. |

## User stories & acceptance criteria

### A. DSC records
- **AC-1** The client page gets a **DSC** tab (Documents · Expected · Requested · **DSC N** · Settings), N = live DSCs. Every role that can see the client sees the tab.
- **AC-2** **Add DSC** (Staff+): **holder name** (1–120, required), **expiry date** (required), **Token PIN / password** (1–100, required, a password field with Show/Hide while typing), and optional **class** (Class 3 · DGFT · Other), **issuer** (free text with suggestions: eMudhra, Capricorn, Pantasign, VSign, IDSign, Other), **token serial / notes** (≤ 200). Several DSCs per client.
- **AC-3** The list shows each DSC: holder, class, issuer, **expiry with status** ("Expires in 23 days" warn · "Expired 4 days ago" bad · "Valid till 12 Mar 2027" ok), and **current holder** (custody, AC-8). Sorted by expiry, soonest first. Archived DSCs are under "Show archived".
- **AC-4** **Edit / renew** (Staff+): every field; a new expiry is a renewal. The password changes only through "Change password" (new value typed twice), never pre-filled.
- **AC-5** **Archive** (Admin/Manager, reason 1–500) for a DSC no longer managed; unarchive. No hard delete.

### B. Password
- **AC-6** The password is **encrypted in the server** before it reaches the database (AES-256-GCM, a key from a server-only env var per environment, Q3). The database stores only ciphertext with a key ID. No list, search, export, zip, activity row, URL, log or error message ever contains it.
- **AC-7** **Reveal** (Staff, Manager, Admin who can see the client; Limited never): a "Show password" button. One server call checks the role and client in SQL, **writes the reveal to activity**, then returns the ciphertext; the server decrypts and returns the plain value in the response body (`Cache-Control: no-store`). It shows for **30 seconds** with a Copy button, then hides again. Every reveal is a new call and a new log row.

### C. Custody (Sankar #7)
- **AC-8** **Given to** (name 1–120, date, optional note) and **Received back from** (name, date, note). The record's current holder is "In office" (after Received back, or with no entries) or "With <name> since <date>". Moves alternate (can't give out a DSC that is already out; `DSC_ALREADY_OUT` / `DSC_NOT_OUT`). Any role that can see the client can log a move (Limited too).
- **AC-9** A DSC that comes back keeps **its record and history** (re-use, no duplicate). A card shows the custody log, newest first.

### D. Expiry reminders
- **AC-10** Client › Settings: "**Remind N days before DSC expiry**" (1–180, default 30), Staff+ (Limited can't, as with other plan settings).
- **AC-11** Today shows a **"DSC expiring"** count and section: live DSCs whose expiry is within the client's N days, or already passed, with holder, expiry status, current holder and a link to the client's DSC tab. Mine = clients I'm incharge of (T3); Everyone = all I can see. Archived DSCs and archived clients are left out. Nothing is sent to clients (Q4).

### E. Activity, roles
- **AC-12** Activity actions (IDs and field names only; never the holder name, custody names or the password): `dsc.created`, `dsc.updated` (fields), `dsc.password_changed`, `dsc.password_revealed`, `dsc.given_out`, `dsc.received_back`, `dsc.archived`, `dsc.unarchived`. Sentences in the catalogue (the coverage test requires them). The Activity screen gets a "Password reveals" filter.
- **AC-13** Permissions matrix (08): rows "Add and edit DSCs" (S/M/A), "Reveal a DSC password" (S/M/A), "Log DSC custody" (all four, Limited for their clients), "Archive a DSC" (A/M). Every cell probed.

### F. Unchanged behaviour
- **AC-14** Today's existing counts and rows, metric 1, client messages (no DSC content), every existing RLS rule and matrix row. The full suite stays green **with no existing test edited** (only additive changes: new probes in `role-matrix.test.ts`, new sentences covered by the catalogue test).

## Functional requirements
- `dsc_save(p jsonb)` (invoker): create or update; the password arrives only as ciphertext (`k<id>.<iv>.<tag>.<ct>`, base64url, format-checked); one activity row.
- `dsc_reveal(p_id uuid) returns text` (**definer**, tenant first, `search_path = ''`): active staff, role ≠ limited, `can_see_client`, not archived → insert activity → return ciphertext. Executable by `authenticated`; useless without the key, and always logged.
- `dsc_custody_log(p jsonb)` (invoker), `dsc_archive(p_id, p_reason)` / `dsc_unarchive` (invoker), `dsc_due(p_scope text)` (invoker, office-first).
- Server-only module `src/lib/dsc/crypto.ts`: the only file allowed to read `DSC_ENC_KEYS` (ESLint fence, like `BREVO_API_KEY`); encrypt with the current key ID, decrypt by the ciphertext's key ID. The server refuses DSC writes and reveals when the key is missing (fails closed).

## Non-functional requirements
- **Security:**
  - the key never reaches the database or the browser;
  - the ciphertext column is excluded from the table's column grant (select only through `dsc_reveal`);
  - CSP unchanged, no third-party script;
  - a **security review** of the crypto module, `dsc_reveal` and the reveal UI before the PR;
  - **written risk acceptance** by Kushal Associates before real passwords are entered on prod (R1 checklist).
- **Privacy:** holder and custody names on the entities only (06's PII-snapshot rule); never in activity, URLs or logs.
- **Accessibility:** WCAG 2.1 AA; axe on the DSC tab, the add/edit dialog and the reveal state; the 30-second hide announced politely.
- **Performance:** DSC tab < 300 ms for 20 DSCs; `dsc_due` < 300 ms at 1,000 clients × 3 DSCs (seeded test).

## Data model changes (additive-only exception, T1)
- `dsc`: office, client, holder_name, dsc_class (enum), issuer, token_note, expires_on, `password_ct text` (format check), password_set_at/by, created/updated by/at, archived_at/by/reason. RLS: select iff `can_see_client`; insert/update Staff+ for visible clients (Limited: none); column grant excludes `password_ct`.
- `dsc_custody` (append-only): office, dsc, direction (`out | in`), person_name, on_date, note ≤ 200, actor, at. RLS: select iff the DSC is visible; writes only through `dsc_custody_log`.
- `client_dsc_setting`: client (pk), office, remind_days (1–180). RLS like `client_doc_type` settings.
- FKs `on delete cascade` only for `reset_test_office` (06's rule); `reset_test_office` itself is **not** changed if cascades cover it — otherwise the one change goes through the schema-lock holder (checkpoint).

## Existing code affected
- `clients/[id]/page.tsx` (tab), new `clients/[id]/dsc-view.tsx` + dialogs; Client › Settings (`plan-view.tsx` or a new card).
- `today/today-view.tsx` (a separate section; `today_items` untouched).
- `lib/auth/permissions.ts` (+4 rows), `lib/activity-feed/catalogue.ts` (+8 sentences), Activity filter.
- `eslint.config.*` (key fence), `.env.example`.

## Backward compatibility & migration
- New objects only; nothing existing is altered (T1). Replay on staging/prod from the file.
- `DSC_ENC_KEYS` / `DSC_KEY_ID` per environment (Vercel server-only), recorded in the R1 checklist. Key rotation: add a new key ID, re-encrypt with a one-off server script, then remove the old key (documented, not automated in R1).
- Rollback: drop the three tables (data loss only of DSC records, which exist only after 14).

## Test strategy
| AC | Unit | RLS (db) | e2e |
|---|---|---|---|
| 1–5 | validation, expiry status text | `dsc.test.ts` (create/update/archive, roles, Limited scope, PII never in activity) | `dsc.spec.ts` (add, edit, renew, archive; axe; 390 px) |
| 6–7 | `dsc-crypto.test.ts` (round trip, tamper → fail, wrong key ID, missing key fails closed) | `dsc-reveal.test.ts` (roles, ciphertext not selectable, every reveal logged, archived refused) | `dsc.spec.ts` (reveal shows, hides after 30 s, copy) |
| 8–9 | — | `dsc.test.ts` (alternation, re-use, Limited can log) | `dsc.spec.ts` (give out, receive back) |
| 10–11 | — | `dsc-due.test.ts` (window, expired, archived, Mine/Everyone, timing seed) | `dsc.spec.ts` (Today section) |
| 12–13 | catalogue coverage | `role-matrix.test.ts` (4 new rows) | — |

**Existing tests that change:** none (AC-14). **RUN_SLOW:** not needed (no 02/03 write path changes).

## Proposed architecture changes
1. **Secrets at rest: application-level encryption** pattern (key outside the database, server-only module, ESLint fence, fail closed, key ID in ciphertext).
2. **Reveal = definer function that logs before it returns** (the first read that is itself an audited action).
3. DSC entity under the client; Today gets a second, separate source (`dsc_due`).
4. Decision row for D5 (passwords stored, reveal = Staff+, risk accepted in writing).

## Risks & areas of concern
- **Password exposure** (intent risk): widest reveal option chosen. Mitigations: logging inside the reveal call, the weekly reveal check, short display, no persistence in the browser, security review, written risk acceptance. [Likely] a later option worth offering after the pilot: a re-confirm step (sign-in code) before a reveal.
- **Key loss = passwords unrecoverable.** The key must be backed up outside Vercel (owner's password manager); in the R1 checklist.
- **Parallel with 13:** overlap only in `permissions.ts`, `role-matrix.test.ts`, the activity catalogue, `today-view.tsx` and the client page tabs (all additive). Merge order at the checkpoint.

## Out of scope
Office-wide DSC list page · header search of DSCs · client reminders about renewal · storing certificate files · portal integration · re-confirm before reveal.
