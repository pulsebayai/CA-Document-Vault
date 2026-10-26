# Intent: Preferred file formats per document type
Author: Raja (drafted with Claude) · Status: **approved (Raja, 2026-10-26 10:20 IST; rev 3)** · Date: 2026-10-26
Roadmap item: 11-file-type-rules · Release: **R1** (Raja + Kushal Associates, 2026-10-26) · Moves product metric: 3 (classification quality) indirectly; mainly staff re-work, see Success metrics

> **Rev 2 (2026-10-26, Raja):** no hard block anywhere, including the client upload page. Every channel warns; nothing is refused for its format. Rev 1 hard-blocked client links.
> **Rev 3 (2026-10-26, Raja):** open questions answered — exceptions per client + type, set by Staff/Manager/Admin; `/documents` filter in scope; starting preferences pre-loaded (list below).
> **Superseded at the spec gate (S1, 2026-10-26):** the two "PDF" rows below pre-load **PDF, XLSX, XLS, CSV** (spec AC-4).

## R1 impact (recorded 2026-10-26)
- 10 holds the schema and architecture locks until it merges (step 13: full CI, RUN_SLOW, PR). 11 needs the schema lock (new columns + seed) and a small architecture note, so **11's spec and plan can be written now; the build starts after 10 merges.**
- [Likely] Build ≈ 2–4 working days plus review. Rev 2 adds **no new refusal to 10's public path**, so it needs less security work than rev 1. It still touches filing paths (03 upload, 10's `/u` page and `link_open` / `link_register`), so RUN_SLOW runs again before merge.
- **Accepted cost:** [Likely] staging/prod and the pilot move by about 4–6 working days, from ≈ 13–15 Nov to ≈ 19–21 Nov. The December GST intake is [Likely] still reachable. Re-check once 11's plan has an estimate.

## Problem
Some document types are only useful to the firm in one format. Bank statements are the main example: staff need Excel or CSV to import into the accounting software, and a PDF statement means re-keying or conversion. Today the vault accepts any allowed format for every type and says nothing, so a client who uploads a PDF statement through a 10 upload link is marked Received, and nobody notices until someone opens the file — often weeks later, when asking again costs a cycle.

**Cost:** staff re-key or convert statements by hand; a late second request to the client; an item that looks complete (metric 1) but isn't usable.

**Constraint from Kushal:** some clients can't produce the preferred format (e.g. banks that email only PDF statements), so the vault must never stop them uploading.

## Proposed outcome
- **Preferred formats per type (catalogue).** Admin/Manager can set an optional list of preferred formats on a document type in Settings › Catalogue, e.g. Bank statement = XLSX, XLS, CSV. The list is a subset of the global allow-list. No list = today's behaviour, with no hint or warning.
- **Pre-loaded preferences** (see "Starting preferences"): set by the migration on the seed catalogue's types, so they are in place on staging/prod from day one. Admin/Manager can change or clear them.
- **Client upload page (10): hint + warning, never a refusal.**
  - Each item card shows the preferred formats ("Excel or CSV preferred").
  - A file in another format triggers a warning before upload: "This item is preferred as Excel or CSV. Upload this file anyway, or choose another?" The client can upload anyway.
  - The file picker does **not** filter by preference (only by the global allow-list, minus ZIP, as today).
- **Staff uploads: the same warning.** Add document, new version, classifying an Inbox document and Upload for a requested item warn when the format isn't preferred for that type and client; staff can file anyway.
- **Flag for review (where the value lands).** A document filed outside its type's preferred formats carries a **"Not preferred format"** flag (e.g. "PDF — Excel preferred") wherever 10's "From client link" badge appears: To review, Client › Documents, `/documents`, document page. Link uploads already need staff review (10), so staff see it at once and can ask the client again in the same cycle — or accept it.
- **`/documents` filter "Not preferred format"** (with a facet count, like 03b's other filters), so staff can list every flagged document across clients.
- **Client exception, per client and type.** On Client › Settings, Staff, Manager or Admin can mark one of the client's types as "any format is fine for this client". For that client + type: no hint, no warning, no flag. Other types of the same client keep their preferences. Setting or removing an exception is logged.

## Users & systems affected
- **Admin/Manager:** set preferred formats on catalogue types.
- **Staff, Manager, Admin:** set or remove client exceptions (for clients they can see); see warnings when filing; see the flag when reviewing. **Limited:** see warnings and flags; cannot set exceptions.
- **Clients (10's public page):** see preferred formats and a warning; never refused for format.
- Systems:
  - `doc_type` (preferred formats); `client_doc_type` (exception, per client + type);
  - document flag: stored at filing (recommended, so a later rule change doesn't re-flag old documents) or computed — decide in the spec;
  - 03: upload / version / classify forms (warning);
  - 10: `link_open` (formats per item), `/u` page (hint, warning); `link_register` records the flag; **no new refusal reason**;
  - 03b: `search_documents` / `search_document_facets` gain the "Not preferred format" filter and facet;
  - Settings › Catalogue, Client › Settings, document rows / page (flag), `/documents` (filter);
  - 08 permission matrix: one new row ("Set a client's format exception"), probed per role;
  - `activity` (preference changes, exceptions; files filed outside preference, IDs and extension only).

## Starting preferences (pre-loaded; decided 2026-10-26)
Only types whose format matters to the firm's work, so flags stay meaningful.

| Seed type (02 catalogue) | Group | Pre-loaded preference | Why |
|---|---|---|---|
| Bank statement | Banking | **XLSX, XLS, CSV** | Kushal's example; imported into the books |
| Salary register / attendance | Payroll | **XLSX, XLS, CSV** | worked in Excel for PF/ESI/TDS |
| Salary paid to employees (for TDS) | TDS/TCS | **XLSX, XLS, CSV** | feeds Form 138 working |
| Payments to vendors / contractors / rent / professionals | TDS/TCS | **XLSX, XLS, CSV** | feeds Form 140 working |
| Capital gains statement from broker / fund house | Income Tax | **PDF** (Raja) | see note |
| Loans & deposits outstanding at 31 Mar | ROC/MCA | **PDF** (Raja) | see note |
| Sales / purchase invoices / registers | GST | none | the type mixes invoices (PDF/images) and registers (Excel): a preference would flag valid files |
| Trial balance & books / Accounting data backup | Audit / Accounting | none | Tally backups arrive as ZIP or Tally files, not Excel |
| Certificates, notices, KYC, challans | various | none | PDF/images are normal; flags would be noise |

**Note on the two PDF rows (to confirm at the spec gate):** "PDF" as the only preferred format means phone photos (JPG/PNG/HEIC) and Word files are flagged — and so is a broker's **Excel** P&L, which [Likely] is the more useful file for capital gains working. If the aim is "a proper document, not a photo", the alternative is **PDF, XLSX, XLS, CSV**. The literal decision (PDF only) is recorded until then.

Seeding matches by the seed type's name in each office; a type an office has renamed or removed is skipped (dev only today; staging/prod are created after 11, so they get the full seed).

## Success metrics
1. **Preferred on arrival:** share of documents for types with a preference that arrive in a preferred format, link and staff separately. Baseline in the first 2 weeks of the pilot; target [Uncertain], set then.
2. **Warning effect (link):** when the client sees the warning, how often they pick another file vs upload anyway. Low switching means the warning alone doesn't change behaviour and the flag + staff follow-up carries the feature.
3. **Time to catch:** for flagged link uploads, time from upload to staff review. Target: same cycle (within 10's review times), instead of "noticed when the file is opened".
4. **Exceptions:** number of client exceptions per type. Many on one type means its preference is wrong for this client base.

## Constraints
- **Nothing is ever refused for format.** Only the existing global rules refuse files (allow-list, ZIP on links, 25 MB, link caps). The server must not add a format refusal anywhere.
- **Format = extension**, as in 03 (no content sniffing). [Certain] A renamed file passes, as today.
- **The warning is advisory UI; the flag is the record.** The server sets the flag at filing for every channel, so a client who skips the page warning (or an old browser) still produces a flagged document.
- **Changing a type's preference or a client's exception affects future uploads only.** Existing documents are never re-flagged or un-flagged (if the flag is stored at filing).
- **Proposed types have no preference** until approved; 05's merge into a type with a preference moves documents without flagging them.
- **Privacy:** no file names in activity; IDs and extension only. The public page shows only format names beyond what 10 already shows.
- **Architecture:** small — a preference check in 03's and 10's filing paths that sets a flag, with no change to access or refusals; 03b's search functions gain one filter. Needs the schema lock (after 10 merges) and an architecture.md note.
- **Volume/K3/K5:** no change to Today or Clients list queries. The flag is a column on the document row, read with the row. The new search filter must not slow 03b's searches (K5: Limited search is already borderline).

## Behaviour that must not change
- Types with no preference behave exactly as today, for staff and links (03 and 10 tests green unedited).
- Every file 10 or 03 accepts today is still accepted.
- 03 filing, DOC-IDs, versions, Inbox; 03b search results for existing filters; 04 linking and metric 1 (a flagged document still counts as received); 07 review; 10's token, expiry, caps, throttles, "not active" page, download-only-until-reviewed.
- The public page still shows no PAN, GSTIN, client code, existing documents or file names.

## Out of scope
- Any hard block on format, for anyone.
- Checking file contents, converting formats, or detecting password-protected PDFs.
- Preferences per period, per registration or per channel.
- A per-client switch covering all types (exceptions are per client + type).
- Re-checking or flagging documents already in the vault.
- Preferences on proposed types.
- Automatic messages to the client about a flagged file (staff ask again manually, through 06 / 10).
- Metric 1 treating a flagged document as not received.

## Decisions (Raja + Kushal Associates, 2026-10-26)
- Separate feature (11), not part of 10.
- Q1: part of R1 (accepted: pilot ≈ 4–6 working days later).
- Q2: preferred format with a warning.
- Q3 (revised): **no hard block anywhere, including the client page** — warnings for clients and staff; staff catch non-preferred files through the review flag.
- Q4: client exceptions kept, **per client and type**.
- Q5: exceptions can be set by **Staff, Manager and Admin** (Limited cannot).
- Q6: `/documents` filter "Not preferred format" is in 11.
- Q7: starting preferences are **pre-loaded** by the migration.
- Q8: the four tabular types pre-load XLSX/XLS/CSV; capital gains and loans & deposits pre-load **PDF** (see note; confirm at spec gate). → **Spec S1: PDF, XLSX, XLS, CSV.**
- Intent approved by Raja, 2026-10-26 10:20 IST.

## Open questions (for the spec)
1. The two PDF rows: PDF only, or PDF + XLSX/XLS/CSV (see note)? → spec S1.
2. Wording of the hint, warning and flag. → spec AC-9–19.
3. Flag stored at filing (recommended) vs computed. → spec S2 (stored).
4. Whether reviewing a flagged document needs an extra step (recommended: no — staff use Mark reviewed or Needs correction as today). → spec S3 (no).
