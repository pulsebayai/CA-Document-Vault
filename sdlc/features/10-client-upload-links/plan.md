# Plan: Client upload links
Spec: ./spec.md · Status: **approved (Raja 2026-10-25: P1, P2 as recommended)** · Date: 2026-10-25
Locks at approval: **schema + architecture → 10** (none held elsewhere). Branch `feat/10-client-upload-links`.
Delivery: two PRs into main, both before the R1 gate (P2): **10a** = steps 0–8, **10b** = steps 9–13.

## Key build decision (P1, approved 2026-10-25)
**Link uploads go through 03's own `create_document`, run as the requester.**
- `link_register` (definer, service-role only) checks token → office → link → item → caps → throttle.
- It then sets the transaction-local JWT claims to the **requester** (`set_config('request.jwt.claims', …, true)`), so `auth.uid()` = the requester.
- Then it calls the unchanged `public.create_document` and `add_document_version` paths.

Result:
- one filing code path: DOC-ID, versions, 03 triggers, 04 linking and 07 status are all untouched;
- D1 (requester owns the upload) comes for free;
- **03's trigger needs no change**, so the spec's `app.link_upload` flag is not needed.

Deviation from spec AC-21:
- `create_document`'s own `document.added` row has the requester as actor.
- A second row, **`document.link_upload`** (actor **null**, data = request + item IDs), records that the client did it, and 08's feed shows "Client uploaded … via <requester>'s link".
- The alternative (a new flag in 03's trigger, actor null on `document.added`) changes the filing path every feature uses. Recommend P1.

Guard: link pages and uploads refuse when the requester is no longer active or can no longer see the client ("not active" page). The requester's assignments decide access, as for any staff upload.

## Files that change
**Migrations (new):**
- `supabase/migrations/<ts>_upload_links_schema.sql`: enums (`doc_channel` + `upload_link`, `notification_kind` + `link_upload`, `upload_item_kind`, `upload_item_status`); tables `upload_request`, `upload_request_item`, `link_attempt`; `document.upload_request_item_id` + index; RLS select policies (visible iff `can_see_client`), no write policies; `reset_test_office` updated for the 3 tables.
- `<ts>_upload_links_staff.sql`: `create_upload_request`, `revoke_upload_request`, `resend_upload_request`, `cancel_request_item`, `reopen_request_item`, `private.note_pii_check`; `begin_email_reminder` / `record_follow_up` gain optional `p_request_id` (same signature + default, so 06 callers are unchanged).
- `<ts>_upload_links_public.sql`: `link_open`, `link_ticket`, `link_register` (service-role only); `private.link_throttle`; AFTER trigger on `document` for ad-hoc item status (WHEN `upload_request_item_id` is not null, plus the status-change variant); `private.notify` for the `link_upload` kind; daily purge of `link_attempt` > 7 days added to the existing daily job.
- `<ts>_upload_links_today.sql` (10b): `today_items` adds ad-hoc rows and the `requested` count in a separate office-first branch; existing branches are byte-identical.
- `<ts>_upload_links_metrics.sql` (10b): `link_metric(p_from, p_to)` (Admin/Manager).

**Server/lib (new):**
- `src/lib/upload-links/token.ts` (generate, hash, build link with `#`);
- `src/lib/upload-links/public.ts` (server-only, service role; ESLint fence);
- `src/lib/upload-links/actions.ts` (staff actions);
- `src/lib/upload-links/note.ts` (PII patterns, shared with the SQL test vectors);
- `src/lib/upload-links/rate.ts` (IP hash with `LINK_IP_SALT`).

**Public page (new):** `src/app/u/page.tsx`, `src/app/u/upload-view.tsx` (client component: reads `location.hash`, then POSTs), `src/app/u/actions.ts`, `src/app/u/layout.tsx` (no staff header; noindex), plus `loading.tsx` and `error.tsx`.

**Modified:**
- `src/lib/supabase/proxy.ts`: `/u` public; extra headers for `/u` (`Referrer-Policy: no-referrer`, `X-Robots-Tag`, `Cache-Control`).
- `src/app/(app)/clients/remind-dialog.tsx`: "Include upload link", ad-hoc item editor, preview line, link state after send.
- `src/lib/reminders/actions.ts`, `message.ts`, `shape.ts`: link line, ad-hoc lines, request ID passed through.
- `src/app/(app)/clients/[id]/page.tsx` + new `requested-view.tsx`: the Requested tab (10b).
- `src/app/(app)/clients/[id]/document-row.tsx`, `src/app/(app)/documents/…` row, document page: "From client link" badge; View hidden while To review.
- `src/lib/documents/actions.ts` `getFileLink`: refuses `view` for unreviewed link uploads (download stays).
- `src/app/(app)/today/today-view.tsx`, `src/lib/today/*` or equivalent: Requested rows and count (10b).
- `src/app/(app)/settings/collection/page.tsx`: link figures (10b).
- `src/lib/activity-feed/catalogue.ts`: sentences for the new actions.
- `src/lib/auth/permissions.ts` + `tests/rls/role-matrix.test.ts`: two rows + probes.
- `src/components/notification-*` (bell text for `link_upload`).
- `eslint.config.*`: fence for `upload-links/public.ts`.
- `.env.example`, `README.md`: `APP_PUBLIC_URL`, `LINK_IP_SALT`.
- `sdlc/product/architecture.md` (lock holder): spec's 5 items + P1.
- `sdlc/product/references/ui-reference.md`: deviation row for the public page.

**Tests (new):**
- `tests/rls/upload-links.test.ts` (staff functions, RLS, PII note guard);
- `tests/rls/upload-links-public.test.ts` (AC-7–9, 20: forged/expired/revoked/cap/throttle/cross-office);
- `tests/rls/upload-links-adhoc.test.ts` (AC-12, 16–19);
- `tests/rls/upload-links-today.test.ts`;
- `tests/unit/upload-links-*.test.ts` (token, note patterns, message lines);
- `tests/e2e/upload-link.spec.ts` (public page on 390 px + axe; staff send → client upload → To review);
- `tests/e2e/requested.spec.ts`.

## Steps
- [x] 0. **Spikes (no merge, ~½ day):** done 2026-10-25 (see session log)
  - (a) A rolled-back SQL proof on dev that the JWT-claims switch inside a definer function makes `create_document` succeed as the requester and fail for an inactive one.
  - (b) **WhatsApp fragment check:** Raja taps a preview link `…/u#test123` from WhatsApp on Android and iOS; a throwaway page shows whether `#test123` arrived.

  If (b) fails, stop and re-decide (fallback: the token in the path plus Vercel log redaction). Proof: notes in the session log.
- [x] 1. Schema migration + RLS tests (visibility per role; no app writes; reset purges the new tables). Proof: `upload-links.test.ts` (schema part); existing `reset_test_office` test green unedited.
- [x] 2. Staff functions + note guard (SQL + TS, same vectors) + 06 send functions taking `p_request_id`. Proof: RLS tests AC-1–5; **06's `follow-up.test.ts` and `chasing-metric.test.ts` green unedited**.
- [x] 3. Token + message builder (link line, ad-hoc lines; still no PAN/GSTIN/DOC-ID). Proof: unit tests, including the logger spy that shows the token is never logged.
- [x] 4. Public functions + throttle + ad-hoc status trigger + notification. Proof: `upload-links-public.test.ts` (every refusal in AC-7–9 and AC-20, the same error for unknown/expired/revoked); `upload-links-adhoc.test.ts` (received / needs-correction reopen); **03/04/07 suites green unedited**.
- [x] 5. Public page + server actions + proxy/headers + ESLint fence. Proof: e2e on 390 px with axe; header assertions; `/u` without a fragment shows "not active"; staff routes still redirect (`auth.spec.ts` unedited).
- [x] 6. Remind dialog: link toggle, ad-hoc editor, preview, send (email and WhatsApp), failed-email retry with the same link. Proof: e2e staff send → client upload → expected item Received → document To review on the requester's Today; **`reminders.spec.ts` green unedited**.
- [x] 7. Badge, View hidden until reviewed, channel facet label, activity sentences (coverage test), permission rows + probes. Proof: unit coverage test, role-matrix test, e2e.
- [ ] 8. **10a close:**
  - architecture.md items;
  - ui-reference row;
  - smoke check for `/u`;
  - verifier full suite;
  - **RUN_SLOW Regression on the branch preview** (02/03 write paths are exercised, not changed; it's run anyway because the filing path is reused);
  - sdlc-reviewer + a second security-focused review of the `link_*` functions;
  - PR 10a.
- [ ] 9. Requested tab: list, Upload (pre-filled and linked), Cancel, Reopen, Revoke, Send again. Proof: RLS + e2e.
- [ ] 10. Today: Requested rows and count (D7). Proof: `upload-links-today.test.ts`; **`today.test.ts` / `today-documents.test.ts` / `today.spec.ts` green unedited**; timing on the volume office ≤ the 09 baseline (K3 not worse).
- [ ] 11. Expiry boundary (IST) and expired-link page; `link_attempt` purge in the daily job. Proof: RLS tests with the test clock.
- [ ] 12. Settings › Collection link figures (AC-23). Proof: RLS fixtures + e2e.
- [ ] 13. **10b close:** full suite, sdlc-reviewer, PR 10b; release-checklist items confirmed in roadmap (security check, WhatsApp/email real send, phone upload).

## Risks
- **Public write path (highest).** Mitigation: every refusal has a test (step 4), two reviews, the R1 security checklist, service-role-only functions, generic errors.
- **JWT-claims switch (P1)** is unusual. Mitigation:
  - it lives in one function, transaction-local;
  - it's tested to fail for an inactive requester;
  - nothing else can call `link_register`, because EXECUTE is revoked from anon and authenticated.
- **WhatsApp may drop the `#` fragment** on some clients. The step 0 spike checks this first; the fallback is ready.
- **Today in K3.** Mitigation: separate query branch; existing tests unedited; volume re-time in step 10.
- **06 function signature change:** a default parameter keeps old callers working; 06 tests unedited.
- **Rollback:** every migration is additive or an additive `create or replace` of a function, and each has a written reverse (drop the new objects; restore the previous function bodies from their files). The feature can also be switched off without a rollback: hiding "Include upload link" and revoking all links disables it.

## Estimate
[Likely] **10a ≈ 7–8 working days, 10b ≈ 4–5**, plus review time. The full feature lands about **3 weeks from approval**, around **13–15 Nov**. [Likely] The pilot then targets the **December GST intake** (early-December documents for November).

## Proof of done
Every AC has a test in the spec's table and the result goes in each PR's AC table. The full regression suite is green, with no existing test edited. RUN_SLOW is green on 10a. The manual items (WhatsApp/email real send, phone upload, security check) are on the R1 staging checklist.

## Deviations from plan
- **Step 2: 06's `begin_email_reminder` / `record_follow_up` are not changed.** Two new functions, `begin_link_email(p)` and `record_link_whatsapp(p)`, reuse 06's private helpers (client and item checks, stale-email close, the per-client cap, the office ceiling, `insert_follow_up`).
  - Why: 06's functions require ≥ 1 expected item, but a request can be ad-hoc only, and 06's code and tests stay untouched.
  - The cap is shared both ways (tested).
- **Step 2: Retry after a failed email issues a new token for the same request** (`retry_link_email`), rather than re-sending "the same link" as spec AC-2 said.
  - The raw token is never stored, so it can't be re-sent.
  - The old token was never delivered, so replacing it is also safer.
- **Step 2: "Send again" is `begin_link_email` / `record_link_whatsapp` with `replaces`** (the old link is revoked and `replaced_by` set in the same call). There is no separate `resend_upload_request`.
- **Step 4: migration D widens 05's `notification_entity_type_check`** (`type_decision`↔`doc_type`, `link_upload`↔`upload_request`). It was missed in the plan's file list and caught by the first test run.
- **Step 4: ad-hoc reopen uses `upload_request_item.reopened_at`** (04's rule): after a reopen, only documents filed later count.
- **Step 4: the link-upload feed sentence is "Vault received <type> through the client's upload link"** (actor null renders as "Vault"; `describeActivity` is unchanged), not "Client uploaded … via Priya's link".
- **Step 4: `test_set_link_caps`** is a service-role helper, refused outside `is_test` offices, so cap tests don't need 30 real uploads.
- **Step 4: DPDP contact.** `office` has no email column, so the page's notice will point to the requester's message ("reply to the message that brought you this link") instead of "the firm's email from settings".
- **Step 6: no inline "propose a new type" in the Remind dialog.** Ad-hoc items use approved types and the client's existing proposed types. A brand-new type is proposed first through 03's Add document flow. This is a change from spec AC-1; R2 can add it if pilot staff need it.
- **Step 6: WhatsApp with a link** opens a blank tab on the click (popup blockers), creates the link on the server, then sends that tab to wa.me (`opener` cleared).
- **Step 6: the link origin** = `APP_PUBLIC_URL`, else on Vercel the deployment's own address (production → `VERCEL_PROJECT_PRODUCTION_URL`, previews → `VERCEL_URL`). CI sets `APP_PUBLIC_URL=http://localhost:3000` (ci.yml). Staging/prod set it explicitly (R1 env checklist).
- **Step 6: `src/lib/upload-links/actions.ts` loads its server-only dependencies lazily**, so 06's dialog unit tests (which mock only 06's actions) keep running unedited.
- **Step 6: 06's `src/lib/reminders/queries.ts` gains one exported function, `chosenItemsAs`** (additive). Its other code is unchanged.
- **Step 7: `tests/unit/permissions.test.ts` (the "matrix reads exactly as approved" snapshot) gains the two rows spec AC-5 approved** ("Send upload links to clients", "Revoke an upload link someone else sent"). This is an additive change for an approved requirement; no existing row changed. `tests/rls/role-matrix.test.ts` gains the two probes its design requires (every row has a probe). Both were flagged to Raja.
- **Step 7: `ClientDocument.fromLink` is optional**, so 07's dispatch-dialog unit test (which builds the type without it) stays unedited.
- **Step 7: "View" stays blocked until the document is Reviewed**, including Needs correction, enforced in `getFileLink` on the server as well as in the UI.
- **Step 2: expiry follows the office day.** `expires_at` = the start of the 15th office day (IST) after creation, so a link is open through day 14. Migration B drops migration A's real-time check, because test offices run on a past clock.

## Session log
### 2026-10-25 (build)
- Step 7: "From client link" badge (Client › Documents, /documents, document page); download only until Reviewed (UI + `getFileLink`); channel label "Upload link" (`DOCUMENT_CHANNELS`/`CHANNEL_LABELS`, search filter accepts it); bell text for `link_upload`; permission rows + probes.
  - e2e `upload-link-review.spec.ts` 3/3; role-matrix 77/77; unit 494/494.
  - Unedited e2e: users, search, client-documents, review-dispatch, type-governance, inbox, add-document 41/41; lint + typecheck clean.
- Step 6: Remind dialog: "Include upload link" switch, ad-hoc rows (type, period, registration, needed-by, note with a live PII check), preview with "‹secure upload link›", Send email (two-phase, Retry with a new token), Open WhatsApp, Revoke.
  - e2e `upload-link-send.spec.ts` 3/3; 06's `reminders.spec` + `today.spec` + step 5 `upload-link.spec` 13/13 unedited.
  - Unit 494/494 (06's dialog unit tests unedited); lint + typecheck clean.
- Step 5: `/u` page (client component reads the fragment, POSTs it), `src/app/u/actions.ts`, `src/lib/upload-links/public.ts` (server-only, ESLint allow-list), proxy (`/u` public + Referrer-Policy no-referrer, X-Robots-Tag noindex, Cache-Control no-store), `.env.example` (`APP_PUBLIC_URL`, `LINK_IP_SALT`).
  - e2e `upload-link.spec.ts` 5/5 on a local production build: headers; inactive page; 390 px + axe; nothing about the client on the page; a real browser PUT → filed To review for the requester → expected item received; ZIP refused; staff routes still redirect.
  - `auth.spec` + `smoke.spec` unedited 10/10; lint, typecheck and unit clean.
  - No firm-email setting (Raja 2026-10-25: go ahead without it). The DPDP notice says "reply to the message that brought you this link".
  - The DOC-ID is not returned to the client page (AC-6).
- Step 4: migrations `20261025134153_upload_links_public` (C) + `20261025134332_upload_links_notification_kind` (D) applied to dev (md5 = files).
  - `upload-links-public.test.ts` 17/17: service-role only; page data has no client name/code/email/mobile; the same "not active" for unknown/revoked/expired/requester left; IP + per-link throttles; ZIP/empty/oversize; foreign items (other link, other office, made-up); caps; requester-owned To review doc via 03; 04 link; document.link_upload actor null; one notification a day; idempotent register; foreign path refused; Limited can't see it; ad-hoc status with needs-correction and reopen; expiry day 14/15.
  - Regression unedited: documents, document-storage, review-dispatch, expected-docs 139/139; type-governance, expected-plan, activity-feed, upload-links, upload-links-staff 119 + 1 skipped (pre-existing RUN_SLOW skip).
  - One fix was in my own new test (`received_on` follows the real filing day, as in 03).
- Step 3: `src/lib/upload-links/{token,note}.ts` and the message builder (`adHocLine`, upload link exactly `<origin>/u#<43-char token>`, else `BAD_LINK`). New unit tests 3 files; 06's `reminder-message.test.ts` unedited; full unit suite 494/494; lint + typecheck clean.
- Step 2: migration `20261025132625_upload_links_staff` applied to dev (md5 of the applied text = the file, for A and B). `upload-links-staff.test.ts` 21/21; 06/08 regression (follow-up, chasing-metric, activity-visibility) + step 1: 40/40 unedited; activity-catalogue coverage 12/12 (5 new sentences); lint + typecheck clean.
- Step 0a: JWT-claims switch proven on dev in a rolled-back DO block: create_document as the requester → DOC-ID issued, received_by = actor = requester; an unknown/inactive sub → `ROLE_REQUIRED`. P1 holds.
- Step 0b: WhatsApp keeps the URL fragment. Raja tapped `en.wikipedia.org/wiki/India#Etymology` from WhatsApp and the page landed on the heading (a Vercel share link wasn't findable, so a public anchor page was used instead). [Uncertain] Confirm the second platform (Android vs iPhone) when convenient.
- Spike branch `spike/10-fragment` was not merged; this session can't delete branches (403), so Raja deletes it.
- Step 1: migration `20261025130428_upload_links_schema` applied to dev (apply_migration); `upload-links.test.ts` 9/9; the reset_test_office users clients-catalogue + documents 75/75 unedited; lint + typecheck clean.
  - Deviation: `upload_request.token_hash` gets a column-level grant exclusion (app roles can't select it). This is stricter than the spec, which said only "hash only".

### 2026-10-25 (planning)
- Done: intent + spec approved; plan drafted. Separate chore PR #2 (activity entity index) fixes the red nightly.
- Next step: Raja approves the plan (P1, P2), then step 0 spikes.
