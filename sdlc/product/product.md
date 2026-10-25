# Product: CA Document Vault
Owner: Raja · Mode: new · Status: approved · Updated: 2026-10-25 (client upload links added to R1, feature 10)
Reference mockup: https://cavault.pulsebay.com (prototype v2, "Sharma & Co"). v1 builds the staff side, reminder emails to clients, and **per-request client upload links** (feature 10, added 2026-10-25). Client login stays deferred.

## Vision
Every document a CA firm needs from its clients is tracked from "expected" to "received" to "returned", lands in the right place, and can be found in seconds.

## Target users
- **Only users in v1:** staff of one Indian CA firm (6–20 staff, 200–1,000 clients). Accounts are created by the Admin — no self sign-up. Roles: Admin, Manager, Staff, Staff (limited).
- **Recipients and uploaders, not users:** the firm's clients. They have no login. Staff remind them in one of two ways, and either can carry a **per-request upload link** (feature 10):
  - by email sent from the vault (replies go to the assigned staff member);
  - by a pre-filled WhatsApp message the staff member sends from their own WhatsApp.

  The link lets the client upload only the requested documents, and staff review every upload.

## Core problem
- **Pain:** recurring compliance documents (GST, TDS, Income Tax, ROC, Banks, Payroll) are expected per client, per period. Staff don't have one reliable view of what is missing, what is late, who owns it, and where received files are.
- **Workaround today:** WhatsApp + email + Excel trackers; staff memory.
- **Cost:** late or missed collection before due dates, files lost across channels, originals not tracked back to clients, no audit trail.

## Product metrics
1. **On-time completeness** — % of expected documents received on or before their overdue date. Baseline: unknown → measured for 2 weeks after feature 04 ships. (Ad-hoc requests from feature 10 never count.)
2. **Chasing load** — reminders per expected document before it is received (email sent from the vault or logged manually). Target: trending down.
3. **Catalogue convergence** — % of documents filed under approved (not proposed) types; target rising month on month as the master list standardises.
4. **Inbox age** — median hours from a file arriving (WhatsApp/email/hard copy/upload link) to being classified in the vault. Target: < 24 h.
5. **Adoption** — % of staff active in the vault on ≥ 4 working days/week.

## Principles
1. **Staff-first speed.** Classifying a received document takes ≤ 3 clicks.
2. **One source of truth.** If it isn't in the vault, it wasn't received.
3. **Nothing is lost.** Every document has an ID, an owner, a status and a history; nothing is hard-deleted (archive only).
4. **India-resident data.** Documents and database stay in India.
5. **Configurable catalogue, fixed workflow.** Firms edit document types and reminder timings; the status workflow itself is not a builder.

## Non-goals (v1)
- Client login or client portal. Clients can't view or download anything. They upload only through per-request links (feature 10).
- Multi-firm SaaS (tenancy, billing, self-serve onboarding).
- Filing returns, reading GST/ITR portals, OCR/auto-classification.
- WhatsApp Business API integration (staff add WhatsApp files manually).
- Practice management (billing, timesheets, general task management).
