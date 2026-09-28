# Intent: Document intake
Author: Raja (drafted with Claude) · Status: draft · Date: 2026-09-28
Roadmap item: 03-document-intake-and-search (search split out to 03b on 2026-09-28) · Release: R1 · Moves product metrics: 4 (inbox age), 3 (catalogue convergence); enables 1 (on-time completeness, via 04)

## Problem
Client documents reach the firm through WhatsApp, email, courier/hand delivery and portal downloads. Today they land in personal phones, inboxes and desk drawers, tracked (if at all) in Excel. Nobody can answer "have we received Sankar's August invoices?" without asking around; files get lost between channels; hard copies and originals have no record; there is no audit trail of who received what, when.

**Cost:** time spent hunting and re-asking clients, late collection before due dates, originals not traceable, no evidence of receipt.

## Proposed outcome
Every document the firm receives — a file or a hard copy — is recorded in the vault **once**, with a **DOC-ID**, who received it, when and how, and is stored privately in India.
- When staff know what it is, they file it straight to its client, type and period (pre-filled from context: the client page, the type's frequency, the period that is due).
- When they don't, it goes to the **Inbox** and is classified later; the Inbox shows what is waiting and for how long.
- Each client's page lists the documents received for them, grouped the way the firm works (group → type → period).
- If the right type doesn't exist, staff can create it on the spot for that client (a **proposed** type — never blocks filing); the admin review queue comes in 05.

## Users & systems affected
- Staff (Admin, Manager, Staff): add, classify, view and download documents; Limited: only for the clients they can see.
- Admin/Manager: archive documents (no hard delete).
- Systems: Supabase Storage (private bucket, ap-south-1), new `document` / `document_version` tables, DOC-ID counter, `activity`, the catalogue (proposed types).

## Success metrics
1. **Inbox age** (product metric 4): median time from a document being added to the Inbox to being classified **< 24 h** — measured from the first 2 pilot weeks (no baseline today).
2. **Speed:** filing a file whose client and type are known takes **≤ 3 clicks after choosing the file** and **≤ 30 s** median — timed manual check with a Staff user (like 02's AC-22).
3. **Nothing unrecorded:** 100 % of stored files have a DOC-ID, a client-or-Inbox state and an uploader; 0 files readable without a signed-in, authorised user (tests).
4. **Catalogue convergence** (product metric 3): % of documents filed under approved types — baseline from the pilot; proposed types are the leading indicator for 05.

## Constraints
- **Storage in India** (Supabase ap-south-1), private bucket, short-lived signed URLs after an RLS-checked lookup; no public links; nothing cached by Vercel.
- **Max 25 MB per file** (Raja 2026-09-28); allow-list PDF, JPG, PNG, XLSX, DOCX, ZIP (architecture); file names sanitised; storage keys never contain client names, PAN or GSTIN.
- **DOC-ID = `DOC-YY-NNNNN`, numbered per office by financial year** (YY = FY start year, restarts 1 April; Raja 2026-09-28). Never reused, never edited.
- **One file per document** (mockup 12); hard copies may have no file.
- No hard delete (archive); every change writes `activity` with IDs/field names only.
- Schema lock held by 03; no architecture change expected beyond storage conventions.
- Volume unknown (Raja): design for one-at-a-time intake; measure volume in the pilot before building bulk intake.

## Behaviour that must not change
02's clients, catalogue and collection plans; approved types stay the only ones offered to other clients; Limited users still see only their assigned clients.

## Out of scope
- Documents/Search screen and header search → **03b**.
- Expected documents, due/overdue, linking a file to an expected document → **04**.
- Admin review queue for proposed types (approve / edit / map / reject) → **05**.
- Remind (email / WhatsApp) → 06 · review → dispatch workflow and "Mark dispatched" → **07** · bulk zip download, activity viewer → **08**.
- Client upload links, OCR / auto-classification, WhatsApp/email integration, bulk multi-file intake.

## Open questions (to settle before the spec)
1. **File types:** add XLS, CSV, HEIC (iPhone photos) and JPEG/PNG variants beyond the architecture allow-list?
2. **Corrected files:** when a client sends a revised file for the same document, is it a **new version** of that document (old kept, one DOC-ID) or a new document?
3. **Channels:** WhatsApp · Email · Hand delivery · Courier · Portal download · Other — the right list?
4. **Inbox visibility:** Inbox items have no client yet — visible to Staff and above only (Limited users see only their own unclassified uploads)?
5. **Archiving documents:** Admin/Manager only (like clients)?
6. **Malware scanning:** none in v1 (files are only opened by staff on their own machines) — accept the risk, or scan on upload?
