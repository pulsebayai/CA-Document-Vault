# Spec: Preferred file formats per document type
Intent: ./intent.md (approved 2026-10-26, rev 3) · Status: **approved (Raja 2026-10-26 10:53 IST: S1–S7 as recommended)** · Date: 2026-10-26
Screens:
- No mockup covers preferred formats. Additions follow `references/ui-reference.md` tokens and components; one agreed-deviation row is added there (format chips, warning, flag badge).
- Extended: Settings › Catalogue type dialog (mockup 05), Client › Settings type rows (mockup 11), Add document / document form (mockup 02), Inbox classify, Client › Documents rows (mockup 10), `/documents` (03b), document page, 10's public page `/u`.

> **Supersedes intent Q8 for two rows (S1, Raja 2026-10-26):** capital gains and loans & deposits pre-load **PDF, XLSX, XLS, CSV**, not PDF only.

## Key definitions
- **Format** = a file's extension, normalised as in 03 (`jpeg` → `jpg`). There is no content check (03's accepted risk, unchanged).
- **Format choices** = the global allow-list **minus ZIP** (S5): PDF · JPG · PNG · HEIC · XLSX · XLS · CSV · DOCX.
- **Preferred formats** (`doc_type.preferred_formats text[]`, null = none) = an optional subset of the format choices on an **approved** type. Null means today's behaviour: no hint, no warning, no flag.
- **Exception** (`client_doc_type.any_format boolean`, default false) = "any format is fine for this client". It exists only on the client's **plan row** for that type (S6).
- **Applies** = the type has preferred formats **and** the client has no exception for that type. A document with no client or no type (Inbox) never applies.
- **Format check** = stored on the document at filing (S2):
  - `document.format_preferred text[]` = a snapshot of the preference that applied, or null when none applied;
  - `document.format_ok boolean` = whether the current version's format was in that snapshot, or null when none applied.
- **Flagged** = `format_ok = false`. It is shown as **"Not preferred format"** with the detail "PDF · Excel or CSV preferred".
- **Format labels** (shown to staff and clients): XLSX/XLS/CSV → "Excel or CSV" (any subset of the three → "Excel" / "CSV" as fitting) · PDF → "PDF" · JPG/PNG/HEIC → "Image" · DOCX → "Word". Lists combine with "or" ("PDF, Excel or CSV"). One TS function and one SQL mirror build the label from the list, tested equal.

## User stories & acceptance criteria
**Setting preferences (catalogue)**
- AC-1 In Settings › Catalogue, the type dialog (Add / Edit type) gains **"Preferred formats"**: one checkbox per format choice, all unticked by default, and a hint ("Staff and clients are warned when a file is in another format. Nothing is refused."). Admin/Manager only, as for every catalogue write (02). The catalogue list shows the preference as a short label next to the schedule ("Excel or CSV preferred").
- AC-2 **Rules:**
  - only format choices are accepted (ZIP and unknown values are refused, in TS and by a DB check);
  - an empty selection is saved as null;
  - proposed, mapped and rejected types can't have preferred formats (DB check). 05's Approve / Edit & approve leave them null.
  - Firm-record types (`source = firm`) may have preferred formats; they apply to staff filing only, since firm records are never requested from clients.
- AC-3 Changing a type's preferred formats writes one activity row (`doc_type.formats_changed`, data = type ID, old and new lists). It affects **only documents filed afterwards** (AC-14).

**Pre-loaded preferences**
- AC-4 The migration sets preferred formats on the seed types below, in every office, when the type exists by its seed name (case-insensitive), is approved, client-source, and has no preference yet. Renamed or removed types are skipped. `private.seed_catalogue(office_id)` (02, test offices and new offices) seeds the same values, so staging/prod and test offices match.

  | Seed type | Preferred formats |
  |---|---|
  | Bank statement | XLSX, XLS, CSV |
  | Salary register / attendance | XLSX, XLS, CSV |
  | Salary paid to employees (for TDS) | XLSX, XLS, CSV |
  | Payments to vendors / contractors / rent / professionals | XLSX, XLS, CSV |
  | Capital gains statement from broker / fund house | PDF, XLSX, XLS, CSV (S1) |
  | Loans & deposits outstanding at 31 Mar | PDF, XLSX, XLS, CSV (S1) |

  The seeding writes one `doc_type.formats_changed` activity row per type changed (actor = system).

**Client exceptions**
- AC-5 Client › Settings shows the preference on each plan row that has one ("Excel or CSV preferred"), with a switch **"Any format is fine for this client"**. When the switch is on, the row reads "Any format (exception)".
- AC-6 **Roles:** Staff, Manager and Admin can set or clear an exception for clients they can see; **Limited can't** (switch read-only). This is enforced in the database (a guard on `client_doc_type.any_format`), not only in the UI. A new permission-matrix row, "Set a client's format exception", is added with a probe for each role (08).
- AC-7 Setting or clearing writes one activity row (`client_doc_type.format_exception_set` / `…_cleared`, IDs only). It affects only documents filed afterwards.
- AC-8 The switch is shown only on rows whose type has preferred formats. The exception survives the row being paused, removed and restored, and survives the type's preference being changed or cleared (it simply has no effect while the type has none).

**Client upload page (10)**
- AC-9 On `/u`, an item whose type applies shows a line under its title: **"Excel or CSV preferred"**. The file picker is **not** filtered by preference: it accepts 10's formats (allow-list minus ZIP), as today.
- AC-10 When the client chooses a file whose format isn't preferred for that item, the page shows a warning **before** uploading:
  > "This document is preferred as Excel or CSV. If you have it in that format, please choose that file. Otherwise you can upload this one."

  with two buttons, **Choose another file** and **Upload anyway**. With several files selected, the warning lists the files not in a preferred format by name (file names stay in the browser) and applies one choice to the selection. Files in a preferred format upload without a warning.
- AC-11 **Nothing is refused for format.** 10's `link_ticket` and `link_register` gain no new refusal. Every file 10 accepts today is still accepted (test: one file of each allowed format for an item that applies).
- AC-12 `link_open` returns, per item, `preferred` = the format list, or null when the item doesn't apply (no preference, or the client has an exception). The page payload gains nothing else: no client data, no exception flag.
- AC-13 The page reports whether it showed the warning. `finishLinkUpload` sends `warned` (boolean) with each registration: true when this file, or an earlier file for the same item in this page session, triggered the warning. `link_register` stores it in its existing `document.link_upload` activity row (`data.warned`). It is untrusted and used only for the metric (AC-24).

**Filing and the flag (every channel)**
- AC-14 **The format check is set by the database** at every filing event, on every path (staff, Upload for a requested item, client link):
  - a document created with a file;
  - a new version;
  - a change of client or type (classifying an Inbox document, or re-classifying).

  The rule: if the preference applies, `format_preferred` = the type's list and `format_ok` = (current version's format ∈ list); otherwise both are null.

  It is **not** re-evaluated when a preference or exception changes later, on 05's merge (`app.type_merge`), on archive/unarchive, review or dispatch. Hard copies and originals with no file are never checked.
- AC-15 The format check can't be set from the app: the columns have no update grant, and only the filing trigger writes them. A direct update through PostgREST is refused (RLS test, each role).
- AC-16 A flagged document shows a **"Not preferred format"** badge with the detail ("PDF · Excel or CSV preferred") wherever documents are listed: Client › Documents, `/documents`, Inbox (after classifying), To review on Today, and the document page (next to 10's "From client link" badge when both apply). The badge has text, not colour alone (WCAG).
- AC-17 **The flag doesn't change review or counting.** A flagged document is To review like any other, counts as received (04 linking, 07 rule, metric 1 unchanged), and staff use Mark reviewed or Needs correction as today (S3: the flag stays after review; it records how the file arrived).
- AC-18 A new version in a preferred format clears the flag (re-evaluated, AC-14). A new version in another format sets it.

**Staff warning**
- AC-19 In Add document, Add version, Inbox classify and Upload for a requested item, when the chosen client + type apply and the chosen file's format isn't preferred, an **inline warning** appears under the file field:
  > "Bank statements are preferred as Excel or CSV for this client. You can still save this file."

  with a link "Allow any format for this client" (Staff+; opens a confirm, then sets the exception as in AC-5–7). Saving needs no extra click (S4). The warning updates as the client, type or file changes, and disappears when the client has an exception.
- AC-20 The warning is computed in the browser from data the form already loads: types carry `preferred_formats`, and the client's plan rows carry `any_format`. The server doesn't check or block. The stored flag (AC-14) is the record.

**Search (03b)**
- AC-21 `/documents` gains a filter **"Format: Not preferred"** (URL `format=not_preferred`) and a facet showing how many visible matching documents are flagged ("Not preferred (7)"). It combines with every existing filter (e.g. Status = To review + Format = Not preferred = the flagged files still to check). The facet follows 03b AC-7: hidden when 0, counted with every filter except its own.
- AC-22 Visibility is unchanged: the filter and facet only ever count documents the user can open (03b AC-10 matrix re-run with flagged documents in each cell).

**Audit and metrics**
- AC-23 **Activity** (IDs, format codes and booleans only; no file names): `doc_type.formats_changed`, `client_doc_type.format_exception_set` / `…_cleared`, and `data.warned` on 10's `document.link_upload`. There is **no new activity row per filing**: the document's format-check columns are the record (S2, a deviation from intent wording, see Out of scope note). 08's feed gets a sentence for each new action (coverage test).
- AC-24 **Settings › Collection** (Admin/Manager) gains a **"Preferred formats"** section for the last 30 days (S7):
  - documents filed where a preference applied, and the share in a preferred format, split by link uploads and staff (intent metric 1);
  - link uploads where the page warned: share that ended in a preferred file vs uploaded anyway (metric 2; from `data.warned` + `format_ok`);
  - median hours from upload to first review for flagged link uploads (metric 3; 10's review-time rule);
  - exceptions per type, top 5 (metric 4).

  Served by one invoker function `format_metric(p_from, p_to)` (Admin/Manager), like 10's `link_metric`.

## Functional requirements
- **One rule, three mirrors:** `src/lib/validation/formats.ts` (format choices, labels, `applies()`, `isPreferred()`), the SQL helpers `private.format_label(text[])` and the filing trigger's check. Unit tests and a DB test keep TS and SQL equal on every format and every seed list.
- **Where the check runs:** in the database, as part of the existing filing triggers, so every path is covered, including 10's link path where RLS doesn't apply (architecture.md, 10a note). The plan decides the exact trigger (03's `document_before_write` already detects the same events for 07's review reset, plus the version insert). The check reads the type's preference and the client's plan row inside the trigger (tenant first).
- **Writes:**
  - preferred formats: 02's existing `upsertDocType` path (Admin/Manager, RLS), with a DB check on values and status;
  - exception: a single-row update through 02's `updateClientDocType` path, plus a guard trigger that refuses a change of `any_format` by a Limited user (`FORMAT_EXCEPTION_ROLE`), and an activity row from the server action (02's single-row pattern);
  - format check: the trigger only.
- **Reads:**
  - the catalogue list, client plan rows and document forms select the new columns;
  - document rows (Client › Documents, Inbox, `/documents`, Today's To review, document page) select `format_ok` and `format_preferred` for the badge;
  - 10's `link_open` adds `preferred` per item;
  - 03b's `search_documents` / `search_document_facets` accept `filters.format = 'not_preferred'` and return a `format` facet.
- **Seed:** the 11 migration updates existing offices (AC-4) and replaces `private.seed_catalogue` so new and test offices get the same values. `reset_test_office` needs no change (no new tables).

## Non-functional requirements
- **Never a refusal:** no server path may refuse a file for its format (asserted for each upload path, AC-11).
- **Security:** no new public function or public data beyond the format list per item; 10's check order and generic errors are unchanged. Guards are in the database (AC-6, AC-15). `search_path = ''` and tenant-first in every new trigger or helper.
- **Privacy:** no file names in activity or metrics; the client-side warning lists names only in the client's own browser.
- **Performance:**
  - filing: the check adds ≤ 5 ms to a save (two indexed lookups by primary/unique key); measured in the RUN_SLOW run against 03's existing save timings;
  - search: the filter and facet must not make `/documents` slower than today at dev volume; **K5** (Limited search borderline at 10k documents) is re-timed with the K3/K4/K5 fixes, not here. A partial index on `document (office_id) where format_ok = false` is added only if the filter is measurably slow;
  - Today, Clients list and the daily job are untouched (K2/K3 not affected).
- **Accessibility:** WCAG 2.1 AA; the client warning is a dialog with focus on "Choose another file" and an `aria-live` summary; the staff warning is linked to the file field with `aria-describedby`; badges have text. `/u` and the forms stay ≤ 390 px (existing assertions).

## Data model changes (schema lock: 11, after 10 merges)
- `doc_type.preferred_formats text[] null`. Check: null, or a non-empty array of distinct values from the format choices; null unless `status = approved`.
- `client_doc_type.any_format boolean not null default false`. Guard trigger: only Staff/Manager/Admin may change it (tenant first).
- `document.format_preferred text[] null`, `document.format_ok boolean null`. Check: both null or both set. No update grant for app roles; written only by the filing trigger.
- No new tables, enums or policies. Additive columns only; existing rows get null / false (AC-14: never back-filled).
- Optional, only if measured slow: partial index `document (office_id) where format_ok = false`.

## Existing code affected
- **02:** catalogue type dialog and list (`settings/catalogue`), `upsertDocType`; Client › Settings plan rows, `updateClientDocType`; `private.seed_catalogue`.
- **03:** filing trigger(s) (`document_before_write` and the version insert path) gain the check; Add document / document form / Add version / Inbox classify gain the warning; document rows and page gain the badge. `create_document` and `add_document_version` themselves are **not** changed.
- **03b:** `search_documents`, `search_document_facets` (replaced, same signature); `/documents` filter chip and facet; URL validation (`format`).
- **05:** none (Approve leaves preferences null; merge skips the check through its existing flag).
- **06:** Today's To review rows show the badge (read only; `today_items` returns the two columns on document rows). **06's counts and order unchanged.**
- **07:** none (review and counting unchanged).
- **08:** permission matrix row + probe; activity sentences.
- **10:** `link_open` (preferred per item), `/u` page (hint, warning dialog, `warned`), `finishLinkUpload` / `link_register` (store `warned` in the existing activity row). No change to tokens, check order, caps, throttles, refusals.
- **Characterization:** 03's filing, 03b's search, 06's Today and 10's public-page suites stay green **unedited**; they already cover the paths touched.

## Backward compatibility & data migration
- Additive columns; no back-fill. Existing documents show no badge and are never counted in AC-24.
- Types with no preference (all but the six seeded) behave exactly as today.
- 03b's search functions keep their signature; callers without `filters.format` get today's results and facets plus one extra facet row only when flagged documents exist.
- Seed applies to dev now; staging/prod get it when their migrations are replayed (R1).

## API / interfaces
- Server actions: `upsertDocType` (+ `preferredFormats`), `updateClientDocType` (+ `anyFormat`), `setFormatException(clientDocTypeId, on)` (used from the staff warning link), `searchDocuments` / `documentFacets` (+ `filters.format`), `finishLinkUpload` (+ `warned`), `formatMetric(from, to)`.
- SQL: `format_metric(p_from, p_to)` (invoker, Admin/Manager); replaced `search_documents(jsonb)`, `search_document_facets(jsonb)`, `link_open`, `link_register` (same signatures; `link_register` reads `warned` from its existing jsonb ticket argument).
- URL: `/documents?…&format=not_preferred`.

## UX flows & screens
- **Settings › Catalogue:** type dialog section "Preferred formats" (checkbox group, hint). List: small label after the schedule.
- **Client › Settings:** on rows with a preference, the label and the "Any format is fine for this client" switch (read-only for Limited, with a tooltip "Staff, Manager or Admin can change this").
- **Add document / Add version / Inbox classify / Upload for item:** inline warning (warn token, icon + text) under the file field, with the exception link for Staff+.
- **Document rows and page:** "Not preferred format" badge (warn style, text), detail on hover/focus and on the document page.
- **`/documents`:** a "Format" chip under "More" (one value, "Not preferred", with its count).
- **`/u`:** "Excel or CSV preferred" under the item title; warning dialog on choosing a non-preferred file.
- **Settings › Collection:** "Preferred formats" section (four figures, 30 days), like 10's "Upload links".
- States: no new screens; existing loading/error states apply.

## Test strategy
| AC | Test | Suite |
|---|---|---|
| 1–3 | catalogue dialog saves/clears; ZIP and unknown refused (TS + DB check); proposed type can't hold formats; activity row with old/new lists | unit + RLS/DB + e2e |
| 4 | seed: the six types in a fresh test office (via `seed_catalogue`) and in an office with a renamed type (skipped); existing preference not overwritten | RLS/DB |
| 5–8 | switch shown only with a preference; Staff/Manager/Admin set, Limited refused by the DB guard; activity rows; survives pause/remove/restore; matrix row probed per role | RLS/DB + e2e |
| 9–13 | `/u` shows the hint; picker unfiltered; warning on a non-preferred file, both buttons; mixed selection; no warning for an exception client; payload has `preferred` and nothing new; one file of every allowed format accepted; `warned` stored | e2e (390 px + axe) + RLS/DB |
| 14–15, 18 | check set on create, version, classify, re-classify, for staff, Upload-for-item and link paths; not on merge, review, archive, preference change; hard copy unchecked; direct update refused for each role; new version clears/sets | RLS/DB |
| 16–17 | badge on every list and the document page; flagged document still counts as received and appears in To review; metric 1 identical | e2e + RLS/DB |
| 19–20 | inline warning appears/updates/disappears with client, type, file, exception; Save works without extra click; exception link (Staff+ only) | unit (form) + e2e |
| 21–22 | filter + facet results; combined with status; 03b visibility matrix with flagged documents | RLS/DB + e2e |
| 23–24 | activity rows IDs/codes only (no file names); feed sentences (coverage test); Collection figures on fixtures | RLS/DB + unit + e2e |
| rule | TS ↔ SQL equality for labels and `isPreferred` on every format and seed list | unit + RLS/DB |
| regression | 03, 03b, 06 Today, 07, 10 suites **green unedited**; RUN_SLOW Regression on the branch preview (filing path) | full suite |

All new tests join the regression suite. **Smoke-safe for prod:** none new (no read-only public surface added).

## Proposed architecture changes (architecture lock: 11, after 10 merges)
1. **Preferred formats are advisory, never enforced.** `doc_type.preferred_formats` (approved types only; allow-list minus ZIP), `client_doc_type.any_format` exception (Staff+ by DB guard), and a **format check snapshot on `document`** set by the filing trigger on create / new version / client-or-type change, on every path including 10's link path (where RLS doesn't apply). No server path may refuse a file for its format.
2. **One format rule in three places** (`src/lib/validation/formats.ts`, SQL helper, filing trigger), tested equal — the same pattern as 03b's search words and 04's schedule mirror.
3. 03b's search functions gain a `format` filter and facet (replaced, same signature).

## Risks & areas of concern
- **Filing trigger change** touches the path every feature uses (03's trigger, also reached by 10's link path and 05's merge). Mitigation: the check is a pure read of two rows by key; 03/04/05/07/10 suites unedited; RUN_SLOW before merge (02/03 write-path rule).
- **Warning fatigue.** If many flagged files are routinely accepted, staff will stop reading the badge. Mitigation: only six types seeded; exceptions per type in AC-24; review after 2 pilot weeks.
- **`warned` is client-reported** and can be wrong (old browser, script). It only feeds a metric, never a decision.
- **Search (K5).** One extra filter and facet on functions already borderline for Limited users at 10k documents. Mitigation: measured at dev volume; partial index only if needed; full re-time with the K-fixes.
- **Size:** [Likely] 3–4 build days plus review (≈ 1 day per area: DB + seed + trigger; staff UI; `/u` + search; metrics + tests). Pilot ≈ 19–21 Nov holds if 10 merges on time.

## Out of scope
- Any refusal on format; content checks; conversion; password-protected PDF detection.
- Back-filling or re-checking existing documents; re-flagging when a preference or exception changes.
- Exceptions for types not in the client's plan (add the type to the plan first) and per-client switches covering all types.
- Preferences on proposed types; ZIP as a preferred format.
- An "Accept format" action that clears a flag (S3).
- A per-filing activity row for files outside preference (intent said "recorded in activity"; the immutable format-check columns on the document record the same fact and are queryable — AC-23).
- Automatic client messages about a flagged file.

## Decisions (Raja 2026-10-26 10:53 IST: all seven approved as recommended)
- **S1. The two PDF rows** (capital gains, loans & deposits): **PDF, XLSX, XLS, CSV** — flags photos and Word files but not a broker's Excel P&L. *(Not chosen: PDF only, the intent's Q8.)*
- **S2. Flag stored at filing** as a snapshot — a later preference change never rewrites history; metrics have a denominator. *(Not chosen: computed live.)*
- **S3. The flag stays after review** as a record of how the file arrived; staff combine the filter with Status = To review. *(Not chosen: an "Accept format" action.)*
- **S4. Staff warning is inline, no extra click.** *(Not chosen: a confirm dialog like the client's.)*
- **S5. ZIP can't be a preferred format** — links refuse ZIP, so a client could never meet it. *(Not chosen: allow for staff-only types.)*
- **S6. Exceptions only on the client's plan types** (`client_doc_type.any_format`). *(Not chosen: a separate exception table.)*
- **S7. Settings › Collection figures (AC-24) in 11** (≈ ½ day). *(Not chosen: after the pilot.)*

> **Plan decisions that refine this spec (Raja 2026-10-26 11:49, plan P1–P3):** AC-6's "guard" is the existing `client_doc_type_update` RLS policy + a column grant (no new trigger); AC-16 drops Today's To review rows (`today_items` unchanged) and the Inbox (Inbox documents can't be flagged).
