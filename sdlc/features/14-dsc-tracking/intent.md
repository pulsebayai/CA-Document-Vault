# Intent: DSC tracking — digital signature certificates under each client
Author: Sidambara (drafted with Claude) · Status: **approved** (Sidambara, 2026-10-31) · Date: 2026-10-31
Roadmap item: 14-dsc-tracking · Release: **R1** (Kushal Associates, Q7) · Moves product metric: 1 indirectly (a lapsed DSC blocks filings, so documents arrive late); principle 2 "one source of truth"
Source: Kushal review 2026-10-29 → `sdlc/feedback/2026-10-29-kushal-review-plan.md` §0 **Q1** (+16:50) and the 30 Oct D-table **D5** (replaces Q2) with **Sankar #7**.

## Problem
A CA firm holds or manages many clients' **digital signature certificates (DSC)**: USB tokens used to sign GST, income-tax, MCA and other filings. Kushal's team tracks them outside the vault today. As a result:
- **Expiry surprises.** A DSC expires (usually after 1–2 years), and the team finds out when a filing fails on the due date. Renewal takes days (verification, new token), so the filing is late.
- **Nobody knows where the token is.** The fob moves between the office, the client and staff. When it is needed there is no record of who has it.
- **The PIN lives on paper or in someone's head.** The firm keeps the token PIN/password with the fob today (D5), so whoever holds the fob holds the password.
- One client can have **several DSCs** (each director or partner, the authorised signatory), and a DSC that goes back to the client often **returns** later: today it is re-entered from scratch.

**Cost:** late filings and penalties traced to an expired or missing DSC; time lost searching for tokens; a password that is neither protected nor audited.

## Proposed outcome
1. A **DSC section on the client page** (Q1: a separate module under the client, not a document type). Each DSC: **holder name, expiry date, password** (required, D5); class, issuer, token serial / holder notes (optional).
2. **Password stored encrypted** (D5), never shown by default. **Reveal** is an explicit click, shown for a short time, and **every reveal is logged** (who, when, which DSC). It never appears in lists, search, exports, activity data, URLs or logs.
3. **In / out custody log** (Sankar #7): "Given to <name> on <date>" and "Received back from <name> on <date>", with the current holder visible at a glance. A DSC that comes back **re-uses its record** (no duplicate), keeping its history.
4. **Expiry reminder** on Today: **30 days before expiry by default**, configurable per client in Client › Settings (Q1). Expired DSCs are shown as expired, not hidden.
5. Renewal: entering the new expiry (and, if changed, the new password) on the same record, logged.

## Users & systems affected
- **Staff / Manager / Admin:** see DSCs of clients they can see, add and edit them, log custody moves. **Reveal:** Staff, Manager and Admin (Q2). **Limited:** see and track DSCs of their clients, never reveal.
- **Systems (detailed in the spec):** a new `dsc` entity (+ custody log + reveal log), encryption key management per environment, Client page section + Client › Settings, Today (`today_items` or a separate call), the permissions matrix (08), activity sentences, `reset_test_office`.

## Success metrics
1. **No surprise expiries:** in the pilot, 0 filings blocked by a DSC that expired without a Today reminder at least N days ahead.
2. **Coverage:** ≥ 90% of the pilot clients' DSCs entered in the vault within 2 weeks of go-live.
3. **Location known:** every DSC shows a current holder (office or a named person); measured as % with a custody entry.
4. **Password access is audited:** 100% of reveals logged; spot-checked on staging.

## Constraints
- **Security first (D5):**
  - encryption at rest with a key that never sits in the database (so a database dump or backup alone doesn't expose passwords);
  - decryption only in a server-only module, after the RLS check;
  - a **security review** before merge;
  - **written risk acceptance** by the firm before real passwords are entered on prod.
- India-resident data (Supabase Mumbai); the key per environment, like `LINK_IP_SALT`.
- No hard delete: a DSC no longer managed is **archived**.
- Holder names are personal data: on the entity only, never in activity data, URLs or logs (06's PII-snapshot rule).
- Parallel with 13 (batch I): no shared tables; small overlap in `permissions.ts`, `role-matrix.test.ts`, the activity catalogue and possibly `today_items` (checkpoint).
- [Uncertain] ≈ 6–9 working days (review estimate, incl. the password work and the security review).

## Behaviour that must not change
- No client login, no automatic sends, client-facing content rules (no PAN/GSTIN; DSC details never sent to clients Q4: Today only).
- Today's existing counts and rows; metric 1 (DSCs are not expected documents).
- Every existing RLS rule and the permissions matrix rows.

## Out of scope
- Signing anything with the DSC, or any integration with the token, the GST / income-tax / MCA portals or the certifying authority.
- Storing the DSC certificate file or the token's private key.
- Ordering or paying for renewals.
- Automatic reminders to clients (Q4).

## Risks — the one to decide with eyes open
**Storing DSC passwords makes the vault a high-value target.** [Likely] A DSC + its PIN lets someone sign returns as the client. Today the risk is physical (the fob and the paper sit together). After 14, anyone with a staff login *and* reveal rights can read every PIN remotely, and a leaked staff session becomes far more damaging. D5 accepted this. The mitigations above (encryption outside the database, reveal-on-demand, logged reveals, narrow reveal rights, security review, written risk acceptance) reduce but don't remove it. Q2 (who can reveal) was the main lever; the decision chose the widest option (see Decisions).

## Decisions (Sidambara, 2026-10-31)
- **Q1 — one field, "Token PIN / password"**, one value per DSC.
- **Q2 — reveal: every Staff, Manager and Admin user who can see the client** (in practice all three roles see every client). **Limited: never.** Every reveal is logged. *Claude's note, kept for the security review and the risk acceptance:* this is the widest of the three options. A leaked Staff session can read every client's PIN, and the reveal log is the only detective control. The spec adds a reveal log screen for Admin/Manager so it is actually looked at.
- **Q3 — application-level encryption** (AES-256-GCM in a server-only module; key in a server env var per environment; the key never reaches the database).
- **Q4 — reminders on Today only** in R1; no DSC content in client messages.
- **Q5 — several DSCs per client**, free-text holder name, no contact link.
- **Q6 — custody "given to / received from" is free text.**
- **Q7 — Today's reminder goes to the client's effective assignee** (06's Mine).
