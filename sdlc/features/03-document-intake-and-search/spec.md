# Spec: Document intake
Intent: ./intent.md · Status: draft (rev 2 — Raja's answers 2026-09-28) · Date: 2026-09-28
Screens: references/mockup/12-add-document.jpg, 02-inbox.jpg, 10-client-documents.jpg (received documents only; expected/overdue = 04, review/dispatch = 07)

## Key definitions
- **Document** = one thing the firm received: a file, or a hard copy (possibly with no file). It has a **DOC-ID**, who received it, when, how (channel), how it arrived (**received as** soft copy · hard copy · original), and a remark.
- **Classified** = has a client **and** a document type. Period and GSTIN/TAN are optional. Unclassified documents are the **Inbox**.
- **Version** = a file attached to a document. A revised file is a new version of the same document (same DOC-ID); earlier versions are kept and downloadable.
- **Proposed type** = a document type a staff member creates while filing, for one client, **after** the vault has shown the closest existing types and the staff member chose none of them. It joins **that client's collection plan** immediately (frequency "as needed", no reminders) and becomes an **approval item** for Admin/Manager, who own the decision (approve, rename/edit, map to an existing type, reject) in 05.
- **DOC-ID** = `DOC-YY-NNNNN`: YY = start year of the financial year in which the document was **added** (IST), NNNNN = per-office counter for that FY, zero-padded to 5 (grows past 99,999 without breaking), never reused or edited.

## User stories & acceptance criteria
**Add a document (mockup 12; header "+ Add document", client page "Add document", Inbox "Add document")**
- AC-1 Staff+ and Limited can add a document: choose **received as** (Soft copy / Hard copy / Original), optionally one file (drag-drop or browse), client, type, period, remark, **channel** (WhatsApp · Email · Hand delivery · Courier · Portal download · Other), **received on** (date, default today IST, not in the future). A soft copy needs a file; hard copy/original may have none.
- AC-2 File rules: ≤ **25 MB**; allowed PDF, JPG/JPEG, PNG, HEIC, XLSX, XLS, CSV, DOCX, ZIP (by extension **and** declared type); empty files rejected. Errors are inline, in plain words, and announced to screen readers. The file goes from the browser **straight to private storage** (not through the app server).
- AC-3 **Context pre-fill:** from a client page the client is set; the type list shows **the client's active plan types first** (group shown under the field), then "Other types" (every approved active type), then "+ New type"; picking a type sets its group and period kind; the period defaults to **the period that just ended** for the type's frequency (monthly → last month, quarterly → last FY quarter, yearly → last FY; "as needed" → Not needed), editable (Not needed / Month / Quarter / Financial year). If the type is per-registration (GST → GSTIN, TDS → TAN) and the client has exactly one active registration of that kind it is set; if several, staff choose.
- AC-4 **Save to vault** requires client and type; **Save to inbox** saves with whatever is filled ("Not sure who this belongs to? Leave it in inbox"). Both assign the next DOC-ID and show it in a confirmation ("DOC-26-00126 saved").
- AC-5 Filing a document with a known client and type takes **≤ 3 clicks after choosing the file** and **≤ 30 s** median for a Staff user (timed manual check, recorded in the PR).
- AC-6 **DOC-IDs** are consecutive per office per FY in the order documents are committed, restart at 00001 on 1 April (IST), and are never reused, even for archived documents; no gaps from failed saves.

**Inbox (mockup 02)**
- AC-7 `/inbox` lists unclassified documents, newest first: file name or "Hard copy", received as, channel, remark, added by, date, DOC-ID, what's missing ("No client" / "No type"), and **how long it has waited**. The nav shows "Inbox" with a count badge (Staff+: all; Limited: their own).
- AC-8 **Assign** opens the same form with what is known; saving with client + type moves it out of the Inbox and records `classified_at` (first time only — used for product metric 4).
- AC-9 Admin, Manager and Staff see every Inbox item; **Limited** staff see only Inbox items they added (and classified documents of their assigned clients, AC-12).

**Client › Documents (mockup 10, received documents only)**
- AC-10 The client page gains a **Documents** tab (count) next to Settings: documents grouped by **group → type → period**, newest period first; each row: type · period, "Received <date> by <name>", DOC-ID, badges **Hard copy** / **Original**, version count if > 1, **View** (PDF/images, opens in a new tab) and **Download**. Filters: FY (default current) and group. Empty state: "No documents received for FY 2026-27 yet" + Add document.
- AC-11 **Document page** `/documents/[id]`: all fields, the **current file** with **View** (PDF/images) and **Download**, the version history (version number, date, who; earlier files kept in storage, not downloadable from the UI in 03 — Raja 2026-09-28), activity summary (who added/classified/replaced, when). Staff+ (and Limited, for documents they can see) can edit classification, received as, channel, received on, remark, and **upload a new version** (same rules as AC-2; the new file becomes current, same DOC-ID). **Archive/unarchive** with a reason: Admin/Manager only; archived documents leave lists but keep their DOC-ID and files.

**Access & storage**
- AC-12 RLS: a document is visible if the user can see its client (02's `can_see_client`), or it is unclassified and (the user is Staff+ **or** added it). Limited users get Not Found for other documents, and 0 rows from the API.
- AC-13 Files are never public: the bucket is private; a download/view link is a **signed URL valid ≤ 60 s**, issued only after an RLS-checked lookup of the document; downloads use the original (sanitised) file name. Storage paths contain only office/document/version IDs — never names, PAN or GSTIN.
- AC-14 No hard delete of documents, versions or files (DB rejects DELETE; storage objects are not removed by the app).

**Proposed types (inline "+ New type")**
- AC-15 Typing a type name shows the **closest existing approved types first** (name and aliases, fuzzy — e.g. "form 16" finds "Form 16 from employer" and "Form 130") with a prompt to use one ("Did you mean …?"). Only if none fits does **"+ New type '…' for this client"** appear: it asks for the group and creates a type with `status = proposed`, `proposed_by`, `proposed_for_client_id`, frequency "as needed", no reminders — and **adds it to that client's collection plan** (`client_doc_type`). If the group isn't enabled for the client yet, a group row is created for the client **holding only this type** (other types of the group are not copied; staff can add them with "+ Add type"). The proposed type is offered only when filing for that client, shows a "Proposed" badge, and creating it never blocks saving the document.
- AC-16 **"Proposed by staff" panel** on Settings › Document catalogue (mockup 05): every pending proposed type with its name, group, who proposed it, when, for which client, and how many documents use it — the **approval item** for Admin/Manager. In 03 it is read-only (with a "decide in the review queue — coming with feature 05" note); approve / edit / map / reject arrive with 05. Admin/Manager can already add types to the catalogue themselves (02) for future client plans.

**Audit**
- AC-17 Every add, classify/re-classify, new version, edit, archive/unarchive and proposed-type creation writes one `activity` row with IDs and field names only — **no file names, remarks, PAN/GSTIN/email/mobile** (enforced by 02's ACTIVITY_PII guard for identifiers; file names and remarks are simply never written).

## Functional requirements
- Upload flow: (1) server action `startUpload(meta)` validates the user, type/size/extension and returns a **signed upload URL** for `office/<office_id>/doc/<uuid>/<version_uuid>.<ext>` (created with the service role in server-only code); (2) the browser uploads the file to Storage directly; (3) server action `saveDocument` / `addVersion` **verifies the object exists** with the declared size and type, then calls a SECURITY INVOKER SQL function (`create_document`, `add_document_version`) that assigns the DOC-ID and writes document + version + activity atomically. A failed step (3) leaves an orphan object and no document (cleanup = later maintenance job, see Risks).
- Bucket `documents`: private, `file_size_limit` 25 MB, `allowed_mime_types` = the allow-list (defence in depth). No `storage.objects` policies for `anon`/`authenticated` — all access through server-issued signed URLs.
- Types offered: client plan types (active, incl. the client's proposed types) → other approved active types. Filing under an approved type that isn't in the client's plan does **not** change the plan; creating a proposed type does (AC-15).
- Period: must belong to the office; kind must be allowed for the type's period kind (month-type: month or quarter or year; quarter-type: quarter or year; year-type: year); "Not needed" = null.
- Registration: must be an active registration of the document's client and of the type's `registration_kind`.
- File names: stored sanitised (control characters, path separators and leading dots removed; max 180 chars); shown in the UI and used for downloads; never logged or put in activity.
- HEIC: stored and downloadable; "View" is not offered (browsers can't render it).

## Non-functional requirements
- **Security/privacy:** RLS default-deny on new tables; `office_id` on each; service-role key only in server-only modules (signing, object verification, test cleanup); signed URLs ≤ 60 s; no PII in URLs, logs, analytics or activity; CSP unchanged except `connect-src` for the Storage upload host.
- **Performance:** Client › Documents with 500 documents renders first view < 1 s server time; Inbox with 200 items < 1 s; a 25 MB upload works on a 10 Mbps connection (progress shown).
- **Accessibility:** WCAG 2.1 AA; the drop zone is also a real file input with a label; upload progress announced; errors linked via `aria-describedby`; screens ≤ 390 px wide on phones (asserted for Add document and Inbox).

## Data model changes (schema lock: 03)
New enums: `received_as` (soft_copy, hard_copy, original), `doc_channel` (whatsapp, email, hand_delivery, courier, portal, other), `document_status` (received) — 07 adds more values.
- `doc_counter` (office_id, fy_code, last int) — PK (office_id, fy_code); incremented in a SECURITY DEFINER function inside the insert (row lock), like 02's client code.
- `document` (id, office_id, doc_code unique per office, fy_code, client_id null, doc_type_id null, period_id null, registration_id null, received_as, channel, received_on date, received_by → staff_user, remark ≤ 500 null, status, current_version_id null, version_count, classified_at null, archived_at/by/reason, created_by/at, updated_at). Checks: soft_copy ⇒ has a version (enforced in the function); registration kind matches type; period office/kind rules (trigger); client/type/period/registration in the same office (tenant-first trigger).
- `document_version` (id, office_id, document_id, version_no, storage_path unique, file_name, mime_type, size_bytes ≤ 25 MB, uploaded_by, uploaded_at). Unique (document_id, version_no). Append-only (no UPDATE/DELETE).
- `doc_type` + `proposed_for_client_id uuid null` (02 already has `status`, `proposed_by`). Check: `status = proposed` ⇔ `proposed_for_client_id` not null; proposed types are `source = client`, frequency as_needed, reminders false.
- Indexes: document (office_id, client_id, fy_code), (office_id, classified_at) partial where null (Inbox), (doc_type_id, period_id); FKs indexed.
- RLS: document/document_version select per AC-12; insert Staff+ and Limited (Limited only for their clients or unclassified); update classification/remark/etc. same visibility; archive columns Admin/Manager (column grants + trigger); DELETE: no policy + `forbid_delete`.
- Storage: bucket `documents` (private, limits above); no object policies for app roles.
- `reset_test_office` extended: documents, versions, counters of test offices (storage objects of test offices removed by the test helper through the Storage API first — the database can't delete storage objects).

## Existing code affected
- Header: "+ Add document" button and "Inbox" nav item with count (01 header, 02 nav rule "no dead links").
- Client › Settings (02): proposed types appear in the plan with a "Proposed" badge; a group row created for a proposed type shows only that type.
- Client page (02): tabs gain **Documents** (default tab when the client has documents? — no: Settings stays default until 04; Documents is a second tab) and an "Add document" button.
- Catalogue screen (02): read-only "Proposed by staff" panel (mockup 05, actions in 05).
- `reset_test_office` and test helpers (02).

## Backward compatibility & data migration
Dev only; additive migrations; `doc_type.proposed_for_client_id` nullable (existing rows unaffected).

## API / interfaces
- Routes: `/documents/new` (optional `?client=<id>` — a UUID, not PII), `/inbox`, `/documents/[id]`, client page `?tab=documents` (UUIDs only in URLs).
- Server actions: `startUpload`, `saveDocument`, `classifyDocument`, `updateDocument`, `addVersion`, `archiveDocument`, `unarchiveDocument`, `getFileLink` (signed view/download URL), `suggestTypes`, `createProposedType`.
- SQL functions (SECURITY INVOKER unless noted): `create_document(jsonb)`, `add_document_version(uuid, jsonb)`, `classify_document(uuid, jsonb)`, `suggest_doc_types(client, query)` (trigram on name + aliases), `create_proposed_type(client, group, name)` (type + plan row [+ client-only group row], one activity row), `private.next_doc_code(office, fy)` (definer).

## UX flows & screens
- **Add document** (mockup 12): centred ~815 px column; drop zone ("Drop a file here or browse · one file per document · optional for hard copies") → file chip with size and remove; card rows Received as · Client ("Not sure who this belongs to? Leave it in inbox") · Document type (group hint; "Only types active for this client are listed first") · Period (segmented Not needed / Month / Quarter / Financial year + selects; FY hint) · Channel · Received on · Remark; footer **Save to vault** (primary) · **Save to inbox**; upload progress bar; on success → back to where the user came from with a toast showing the DOC-ID.
- **Inbox** (mockup 02): rows per AC-7, "Assign" button; empty state "Inbox is empty — everything received has a client and a type."
- **Client › Documents** (mockup 10 minus expected/overdue/Remind/review/dispatch): group cards with type · period rows, badges, View/Download; FY + group filters.
- **Document page:** details card, versions list, "Upload new version", Edit, Archive (Admin/Manager).
- Every screen: empty, loading (skeleton, `role="status"`), error (banner + retry) — 02's `states.tsx`.

## Test strategy
| AC | Test | Suite |
|---|---|---|
| 1, 2 | file rules (size, extensions, types, empty), sanitiser, soft copy needs a file | unit + e2e |
| 3 | period default per frequency and date (incl. April/quarter boundaries); type ordering; registration auto-pick | unit + e2e |
| 4, 6 | DOC-ID sequence per FY, restart on 1 April (function called with a fixed date), no gaps on failure, never reused | RLS/DB |
| 5 | timed manual check (Staff user) | manual (PR) |
| 7–9 | Inbox list, assign, `classified_at` first time only; Limited sees own Inbox items only | RLS/DB + e2e |
| 10, 11 | client documents grouping/filters; document page; new version keeps DOC-ID and becomes current; archive roles | e2e + RLS/DB |
| 12 | visibility matrix (Admin/Manager/Staff/Limited × assigned/unassigned × classified/unclassified × own/others') | RLS/DB |
| 13 | bucket private (anon/authenticated can't read or list objects); signed URL works then expires; path has no names | RLS/DB (storage API) + e2e download |
| 14 | DELETE rejected on document/version | RLS/DB |
| 15, 16 | suggestions (fuzzy + aliases); proposed type joins the client plan (and a client-only group row when needed); offered only for its client; catalogue panel lists it read-only | RLS/DB + e2e |
| 17 | activity rows; no file names/remarks/PII in `data` | RLS/DB |
| NFR | axe on Add document, Inbox, Client › Documents, Document page; ≤ 390 px; screenshots vs mockups 02/10/12 | e2e |
- All new tests join the regression suite. **Smoke-safe for prod:** none added (all write data or need sign-in).
- Test files: synthetic, generated in the test (tiny PDF/PNG/CSV bytes; one 25 MB + 1 byte buffer for the limit test — not uploaded). Test offices' storage objects removed through the Storage API at run start, then `reset_test_office`.

## Proposed architecture changes
1. **Upload path:** browser → private Supabase Storage via a **server-issued signed upload URL**; the server verifies the stored object before creating the document; no Storage policies for app roles (all access via server-issued signed URLs). Reason: 25 MB files can't pass through Vercel functions (≈ 4.5 MB request limit); keeps authorisation in one place (RLS on `document`).
2. **DOC-ID per office per FY** (`doc_counter`), `DOC-YY-NNNNN`, YY = FY of the date added (Raja 2026-09-28).
3. **Proposed types join the client's plan immediately** (as architecture already says) — clarified: if the group isn't enabled for the client, a client group row is created holding only the proposed type (no other types copied). Approval/mapping stays with Admin/Manager in 05 (Raja 2026-09-28).
4. `document.received_as` = soft copy · hard copy · **original** (original = hard copy the firm must return; 07 uses it for dispatch); `doc_channel` list per Raja.

## Risks & areas of concern
- **Orphan files** (upload succeeds, save fails or the tab closes): harmless (private, unreferenced) but cost storage → record count in a nightly check later; cleanup job before the pilot's second month. [Likely] rare.
- **Declared type ≠ real content** (renamed .exe → .pdf): allow-list + bucket MIME check only — no content sniffing or malware scan in v1 (accepted risk, intent).
- **Storage in tests** writes real objects to dev → tiny files, removed at the start of each run for test offices only.
- **Scope at the 2-week edge** even after the split — the plan will show session estimates. Raja 2026-09-28: keep the "Proposed by staff" panel; View/Download for the current version only (older versions not downloadable in 03).
- **DOC-ID "FY of the date added"** vs "FY of received on": a document received 31 March but added 2 April gets DOC-27-… — acceptable (IDs are intake IDs), stated in the UI help.

## Out of scope
Documents/Search screen and header search (03b) · expected docs, "due" hints, Remind, linking to expected docs (04/06) · proposal review queue (05) · review/dispatch statuses (07) · bulk download, activity viewer (08) · bulk multi-file intake · OCR, content sniffing, malware scanning · client access/upload links.

## Decisions (Raja 2026-09-28)
Proposed type: suggest existing first; if none fits, create it **and add it to the client's plan**; Admin/Manager own approval (05) and can add catalogue types themselves · DOC-ID FY = date added · "Original" as a third received-as value · architecture changes 1, 2, 4 approved (3 revised as above) · keep "Proposed by staff" panel · View/Download for the current version only.
