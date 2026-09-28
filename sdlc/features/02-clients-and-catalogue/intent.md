# Intent: Clients and document catalogue
Author: Raja · Status: approved · Date: 2026-09-26
Roadmap item: 02-clients-and-catalogue · Release: R1 (Pilot) · Moves product metric: enabler for 1 (on-time completeness) and 3 (catalogue convergence)

## Problem
Nothing downstream (filing documents, expected docs, reminders) can work until the vault knows **who the clients are** and **what each client is expected to send, how often**. Today that knowledge lives in Excel trackers, WhatsApp chats and staff memory: client details are scattered, each staff member names document types differently, and no one can say which recurring documents a given client owes. Re-typing 200–1,000 clients by hand before the pilot would stall adoption (metric 5).

## Proposed outcome
- **Catalogue masters** (Settings › Catalogue): document groups, document types with a default schedule (frequency, ask day, overdue day, reminders on/off), financial years and generated periods. Seeded from a **standard Indian CA catalogue** (GST, TDS/TCS, Income Tax, Banking, ROC/MCA, Payroll, Audit, Accounting, Registrations, Other) with default ask/overdue days from **statutory due dates** (e.g. GSTR-1 11th, GSTR-3B 20th, TDS challan 7th; ask day a few days earlier). The CA overrides any default in Settings › Catalogue.
- **Clients**: list, add, edit, archive (never delete) with a **vault-generated client code** (sequential per office, e.g. C0001; not editable), client type, optional free-text **previous reference** (the firm's old Excel/file code; searchable, not unique), PAN, contact details, 1..n registrations (GSTIN/TAN + state) and an incharge.
- **CSV import**: fixed template; preview with per-row errors; import only valid rows; rows duplicating an existing PAN (or a PAN earlier in the same file) are skipped and reported; codes are assigned on import.
- **Client collection plan** (Client › Settings): enabling a group copies all its active types into the client's own instances (`client_doc_type`) with the default schedule; staff untick types that don't apply and adjust schedule, assigned staff, start period, active/paused. Later master edits never silently change existing clients.

## Users & systems affected
- Admin/Manager: maintain catalogue; archive clients; change incharge.
- Staff: add/edit clients, import, enable groups and tune a client's plan.
- Limited: read-only, assigned clients only (RLS).
- Systems: new tables client, client_registration, client_contact, doc_group, doc_type, financial_year, period, client_group, client_doc_type, activity (+ RLS). Screens: Clients, Add client, Client › Settings, Settings › Catalogue.

## Success metrics
1. The CA's real client list (sanitised copy on dev; real file on prod at pilot) imports in **≤ 10 minutes** including fixing errors, with **≥ 95 %** of rows accepted first time.
2. Setting up one client's collection plan (enable 2–3 groups, untick irrelevant types) takes **≤ 2 minutes** (timed with a staff member).
3. At pilot start, **100 %** of pilot clients have ≥ 1 active group and an incharge (query).
4. Seed fitness: in the first pilot month, **≥ 80 %** of filed documents use a seeded (not staff-proposed) type — measured by query after 03 ships; baseline for metric 3. (Replaces a pre-launch coverage check, since no tracker list is supplied.)

## Constraints
- Must follow architecture.md: dimensional model, masters referenced by ID, RLS on every table, `office_id` on business tables, no hard delete, every mutation writes `activity`.
- PAN, email, mobile are personal data: never in URLs, logs, analytics or test fixtures (fixtures use synthetic PANs and `.test` emails).
- Holds the schema lock (Batch A); 03 and 04 build on these tables.
- UI per mockup (`references/ui-reference.md`), WCAG 2.1 AA.
- Real client data only in prod; the CA's export is used on dev only after anonymisation.

## Out of scope
- Documents, uploads, Inbox (03) · expected-doc generation and due/overdue (04) · type proposals and admin review queue (05) · reminders (06).
- Flexible CSV column mapping; client-type presets for groups; "apply master change to existing clients" bulk action (unless trivial — decide at spec).
- Client contacts beyond one primary email/mobile (client_contact kept as reference only).

## Decisions (2026-09-26)
1. No CA export supplied → seed from a standard Indian CA catalogue; generic fixed CSV template. Deliberate: the firm's naming is ad hoc today, so the vault standardises it rather than copying it. Risk accepted: more staff-proposed types early (caught by metric 4 / feature 05).
2. Client code is **vault-generated only**; the old code/reference goes in the optional `previous_reference` field (also a CSV column) for migration look-ups.
6. 02 stays one feature (no 02a/02b split); revisit only if the plan exceeds ~10 working days.
3. Client types (default list, admin-editable later): Individual, HUF, Proprietorship, Partnership firm, LLP, Private Ltd, Public Ltd, Trust, Society, AOP/BOI, Co-operative.
4. Launch FYs **2025-26 and 2026-27**; quarters are **FY quarters** (Q1 = Apr–Jun), matching GST/TDS returns.
5. Default ask/overdue days from **statutory due dates**; CA overrides in Settings.

## Open questions (resolve at spec)
1. "Apply master change to existing clients" — in 02 or deferred?
