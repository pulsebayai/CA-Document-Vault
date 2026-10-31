# Plan: Kushal Associates review feedback (2026-10-29)

Source: review by Sidambara + Sankaranand with Kushal's team, 2026-10-29 (19 asks, 6 open questions).
Checked against: `main` @ d601122 (code), roadmap 2026-10-28, data-model-v3.
Status: **client decisions recorded 2026-10-29 (§0) — needs owner (Raja) approval before any item enters the roadmap.**

## 0. Decisions recorded — 2026-10-29 (Kushal Associates, via Sidambara)

These answer the questions in §4 (two rounds, 16:18 and 16:26). Where a decision changes the plan below, this section wins.

| Q | Decision | What it changes |
|---|---|---|
| Q1 | **DSC is a separate module under the client**, not a document type. **Reminder 1 month before expiry by default, configurable per client** (added 16:50) | New feature **14-dsc-tracking**: a DSC section on the client page with holder, class, issuer, expiry date and who holds the token. Reminders follow 06 (Today + Remind). A per-client setting, "Remind N days before DSC expiry" (default 30), in Client › Settings |
| Q2 | ~~No password is stored~~ → **replaced by D5 (30 Oct): passwords ARE stored** | No secrets in the vault. The §5 password risk no longer applies. DSC drops to a medium-sized feature with no extra security design |
| Q3 | **Reception marks receipt only; the scan is attached later from the Inbox. Reception staff use the Staff role** | Reception desk mode (A20) is a short "Log receipt" form: client, what was received, how many, **handed over by** (A4). It creates a hard-copy document with no file in the Inbox, and staff attach the scan from there. No new role, and no permission change |
| Q4 | **Staff, Manager and Admin can edit details after filing, including group and document type. Staff can also undo a review** | Edit: no permission change (today's rule). **Undo review moves from Admin/Manager only to Staff+.** This changes 08's permission row "Undo a review or a dispatch": it splits into "Undo a review" (Staff+) and "Undo a dispatch" (Admin/Manager, unchanged), with RLS probes and tests. Limited stays as today |
| Q5 | **A "My clients" default filter is enough** | A16a stays. **A16b (hard access restriction) is dropped** |
| Q6 | **20 rows per page, most recently received at the top** | `/documents` and Client › All documents: page size 50 → **20**. Default sort = date received, newest first (already today's default) |
| Q7 | **Everything is needed before Kushal starts using the app, i.e. before the pilot** | All agreed items are pre-pilot: features 12–15 in §3 |
| Q8 | **"Document in office"** comes after Reviewed and before Ready to dispatch. **Every hard copy passes through it, returnable or not.** The user moves a document on with a click, and **Staff can undo it** (added 16:50) | A17, per the **Returnable** checkbox (A3): returnable = Reviewed → Document in office → Ready to dispatch → Dispatched; non-returnable = Reviewed → Document in office (final: the firm keeps it). Actions: "Mark in office" / "Ready to dispatch" on the document page and in bulk on `/documents`, each with Undo for Staff+. Ready to dispatch is derived today; it becomes a stored step, so 07's state order, Today's counts, `/documents` filters and the dispatch dialog all change. It replaces "Processing" |

**Nothing is open.** The last points (how Document in office is used, and where DSC sits and when it reminds) were answered at 16:50.

**Schedule after Q7:** [Uncertain] These estimates are from past feature velocity; nothing has been specified yet.

| Work | Estimate |
|---|---|
| Phase 1 fixes, incl. undo-review permission change | ≈ 5–7 working days |
| K4 fix + Client › All documents tab | ≈ 3–4 days |
| "Document in office" state + reception mode | ≈ 3–5 days |
| DSC tracking (no passwords) | ≈ 3–4 days |

- **Total ≈ 3–4 weeks of build and review**, then staging/prod (≈ 1 week).
- The pilot moves to roughly **early-to-mid December**. [Likely] That still risks the early-December GST intake, so January may be the first full cycle.
- Option to protect December: ship in two drops and start the pilot after drop 1, if Kushal can start without DSC.
  - **drop 1** = Phase 1 + custody + reception;
  - **drop 2** = DSC + All documents.
- Raja and Kushal to confirm the date.

### Decisions — 30 Oct, after Sankar's comments on the discussion note (Sidambara with Kushal + Sankar, 15:04)
| # | Decision | Effect |
|---|---|---|
| D1 | **Handed over by = one text field** (a name), no kind dropdown | 12: spec AC-14 changes; migration C drops `handed_over_kind` (A already applied on dev) |
| D2 | **Inbox is renamed "Untagged documents"** ("filing" means tax filing to a CA) | 12: replaces Q2 ("keep Inbox"). Every on-screen "Inbox" label changes; the route `/inbox` stays |
| D3 | **"+ Propose a new type" stays inline for Staff, as today** | 12: no change |
| D4 | The "Other types" heading in the type field reads **"Not in existing category plan"** | 12: spec AC-2 wording |
| D5 | **DSC passwords ARE stored** (Kushal + Sankar; the firm keeps the password with the key fob today). **Replaces Q2.** Sankar's #7 adds: DSC in/out custody log, re-use of an existing DSC on return; required = holder name, expiry, password; rest optional | 14: needs encryption at rest, reveal-on-demand with a logged reveal, never in exports/search/logs, a security review, and written risk acceptance. [Likely] +3–5 days on 14 |
| D6 | **Client upload links stay in R1** (feature 10, shipped) | none |
| D7 | **Email moves to AWS SES (Mumbai) after 12, during staging/prod setup.** Reverses the 2026-10-01 Brevo decision | Staging/prod path: SES for sign-in codes (Supabase Auth SMTP) and the vault mailer. Architecture decision row at that time |
| D8 | **Automatic client emails** on document received and on Ready to dispatch (Sankar #16), once on SES | New feature (proposed **16-client-notifications**). Changes the project rule "no automatic sends", so it needs its own intent. Release to confirm |
| D9 | **Files stay in Supabase Storage** (private, Mumbai); no move to S3 | none |
| — | Sankar #1 (trash bin), #6 (reception paper IDs with client code), #10 (Limited = my clients: already so), #14 (30-day "in office" flag) | #14 → 13. #6 → 13's intent (recommendation: DOC-ID + client code, no second ID). #1 → not decided |

## 1. Bottom line

1. **About half of the asks are already built; the gap is mostly visibility, wording and defaults.** [Certain — checked in code] These already exist:
   - edit after filing (including type and group);
   - archive and restore;
   - a per-document activity timeline, and a client Activity button;
   - undo review;
   - dispatch details;
   - the type proposal queue;
   - the `/documents` table with filters, multi-select, sort and pagination.

   Showing these in a walkthrough avoids rebuilding them.
2. **"Inbox" means "not yet filed" in the app; the reviewers expected a personal work queue.** [Certain] That queue already exists as **Today › To review**, so this is a wording and navigation fix, not a new routing model.
3. **All agreed items are now pre-pilot (Q7).** [Uncertain] That is ≈ 3–4 weeks of build and review plus ≈ 1 week of staging, so the pilot lands around early-to-mid December. That puts the early-December GST intake at risk (see §0 schedule).
4. **Two earlier risks are resolved by the decisions:**
   - DSC keeps **no passwords** (Q2).
   - Staff visibility is a **default filter**, not an access restriction (Q5).

   The one design guard still in force: a typed document type **proposes** a new type into the approval queue rather than creating one (A5). This keeps the catalogue clean.

## 2. Gap analysis — each ask against what exists

| # | Ask | What exists today | Real gap | Size |
|---|---|---|---|---|
| A1 | Preview/download from Inbox | View/Download only on client document rows + document page | Add file buttons to Inbox rows (and `/documents`, Today) | S |
| A2 | Unassigned items appear in Inbox | Works as designed: Inbox = unfiled only | **Expectation mismatch** — rename/subtitle ("Unfiled"), point to Today › To review | XS |
| A3 | Remove "Original" tab → returnable checkbox | "Received as" = Soft copy / Hard copy / Original (one choice) | Split into **medium** (soft/hard) + **Returnable** flag; migrate `original` → `hard_copy + returnable`; 07 dispatch + search "returns" filter + Today follow the flag | M (schema) |
| A4 | "Handed over by" for hard copies | Channel (hand delivery, courier…) + remark only | New field: who brought it (client staff / courier / security + name). Required for hard copy | S (schema) |
| A5 | Document type as a typeable field (Kushal 2026-10-29: "the dropdown grows into a huge list") | Built as a `<select>` (client's plan types + every other approved type + "+ New type…"). **Sankar's prototype (cavault.pulsebay.com › Add document), which is the UI source of truth, has a type-ahead search field instead** (placeholder "Type to search, e.g. invoices, 26AS, notice"). It shows suggestions under **group headings** (GST, Income Tax, TDS), frequency on the right, and "+ Propose a new type… needs approval" last. The `<select>` was an **unrecorded deviation** from the mockup (not in ui-reference.md's deviation table) | **Build the prototype's field**, on Add, Assign and Edit. Additions the real data needs: (1) while typing, also search types outside the client's plan, under an "Other types" heading (Edit across groups needs them); (2) hide group headings with no matches (the prototype shows empty INCOME TAX / TDS headings); (3) match short forms and ignore hyphens ("3B" → GSTR-3B); (4) cap the visible list with "keep typing to narrow"; (5) keyboard ↑ ↓ Enter Esc + ARIA combobox (WCAG AA); (6) no match → close types first, then Propose (keeps the 05 queue). Claude's earlier canvas ("Document type picker prototype", group as a side pill) is **superseded** by Sankar's pattern | S–M |
| A6 | Edit metadata after upload — **incl. changing type and group (e.g. GST → Banking)**, Kushal 2026-10-29 | **Exists**: document page › Edit lets you change client, type, period, registration, received as and remark. Every approved type in every active group can be chosen ("Other types"). The group follows the type, so GSTR-3B → Bank Statement moves the document from GST to Banking. The database allows it (03/07 trigger): the DOC-ID stays the same, a reviewed document goes back to To review, and the change is logged | **UX only:** the group shows as read-only ("set from the type"), and the type list is one long dropdown, so it *looks* locked. Use the **type-ahead field from A5** on Edit too (decided 2026-10-29: it replaces the earlier Group → Type two-step idea), a confirm line ("Moves from GST › GSTR-3B to Banking › Bank Statement; review resets"), and an Edit button on rows and on the Needs-correction banner. Schedule/frequency is a **client plan** setting, not a document field — link to Client › Settings | S |
| A7 | Change category/schedule/reminder frequency | **Exists** in Client › Settings (plan rows, frequency) | Discoverability only; confirm with Sankar | XS |
| A8 | Unmark / re-mark Reviewed | **Exists** as "Undo review" — Admin/Manager only | **Decided (Q4): Staff can undo a review too.** Split 08's permission row; undo dispatch stays Admin/Manager | S |
| A9 | Needs-correction flow | Needs correction → upload a new version (file problem). Metadata problems → Edit | Split the reason: "Wrong file" (new version) vs "Wrong details" (edit, then back to To review). Edit should clear needs-correction | S |
| A10 | Soft delete → archive, restore | **Exists**: Archive (reason required) + Unarchive, Admin/Manager; archived docs leave lists | Add an "Archived" filter/view on `/documents` if not obvious; confirm Staff shouldn't archive | XS |
| A11 | Excel-like All Documents table | **Exists**: `/documents` — filters on every dimension, facets, sort, multi-select (zip, mark reviewed), pagination | Page size **20**, newest received first (Q6). Column chooser / saved views: not requested, not in scope | S–M |
| A12 | Viewer icons everywhere | See A1 | Same as A1 | — |
| A13 | Document timeline/history | **Exists**: document page Activity card + review/dispatch history | Perf issue **K4** (times out at volume) must be fixed before rollout anyway | — (K4) |
| A14 | Client-level activities next to Add Document | **Exists** (corrected 2026-10-29): the client page header has an **Activity** button next to Add document, which opens `/activity?client=…` | None. Show it in the walkthrough | — |
| A11b | **Client › All documents** table with per-document activity (Kushal, 2026-10-29) | Client › Documents = grouped cards (group → type → period, with expected items). `/documents` = cross-client table (it can filter by client, but there's no link from the client page). Activity per document is only on the document page (20 latest + "See all") | New client tab **All documents**: the `/documents` table scoped to this client and FY. Add a **Last activity** column (who · what · when) and an expandable row showing the document's **5 latest events + "See all"** (opens the document's full history; decided with Kushal's team 2026-10-29). Keep the grouped tab, which is what shows missing/expected items. Needs the **K4** fix (index activity by document) first, or the per-row activity will time out at volume | M |
| A15 | Pagination for long lists (GST monthly) | `/documents` paginates; **Client › Documents does not** (group cards, 5 open + "more") | Paginate/virtualise Client › Documents per FY | S |
| A16 | Staff see only "my clients"; category-level access | Staff/Manager/Admin see **all**; Limited = assigned only. Client incharge + per-group incharge already stored | **Decided (Q5): a "My clients" default filter** (incharge or group staff), switchable to "All clients". It is a convenience, not security. The hard access restriction is **dropped** | S |
| A17 | **"Document in office"** state (Q8) | States are derived: Reviewed original = Ready to dispatch | **Decided (Q8):** every hard copy goes Reviewed → **Document in office**; returnable ones then go → Ready to dispatch → Dispatched. Each move is a user click (page + bulk), and Staff can undo it. A new stored state; changes 07 state rules, Today counts, `/documents` filters and the dispatch dialog | M (schema) |
| A18 | Dispatch metadata | **Exists**: method (courier, hand delivery, client collected, other), courier + tracking, recipient, date; Undo dispatch | Maybe add "collected by (client side)" if different from recipient | XS |
| A19 | Digital signature tracking | Nothing | **Decided (Q1, Q2):** a separate DSC module **under the client**, tracking only, no password. Holder, class, issuer, expiry, token holder. Reminder **30 days** before expiry by default, **configurable per client** | M |
| A20 | Reception/desk mode | Add document already accepts a hard copy with **no file**, which goes to the Inbox | **Decided (Q3): receipt only, using the Staff role.** A short "Log receipt" form (client, what, how many, handed over by); the scan is attached later from the Inbox | S–M |

Size: XS < ½ day · S ≈ 1 day · M ≈ 2–4 days · L ≈ 1–2 weeks, incl. tests and review. [Uncertain] These are estimates from past feature velocity; a spec has not been written yet.


## 3. Delivery plan (all before the pilot — Q7)

### Step 0 — Walkthrough (this week, no code)
- Show Sankar + Kushal what already exists, so the build list doesn't redo it: Today › To review, document Edit, Archive/Unarchive, `/documents`, client Activity button, Client › Settings frequency, dispatch dialog.
- No open decisions left; the walkthrough is for showing what already exists.

### Feature 12 — intake-review-fixes (≈ 5–7 days)
1. File view/download on Inbox, `/documents` and Today rows (A1/A12).
2. Inbox wording ("Unfiled") + a pointer to Today › To review (A2).
3. Returnable checkbox replacing "Original", with data migration (A3).
4. "Handed over by" on hard copies (A4).
5. Type-ahead Document type field from Sankar's prototype, on Add, Assign and Edit (A5).
6. Edit discoverability, confirm line when the type/group changes, and Needs-correction split into "wrong file" vs "wrong details" (A6/A9).
7. **Staff can undo a review** (A8, Q4): split 08's permission row, RLS probes.
8. Client › Documents pagination (A15); **20 per page, newest received first** on `/documents` (Q6).
9. "My clients" default filter (A16, Q5).

Schema items (3, 4) take the schema lock and change 03's filing trigger and 07's rules → **RUN_SLOW before merge**.

### Feature 13 — hard-copy-custody (≈ 3–5 days, after 12: it builds on the returnable flag)
- **"Document in office"** state between Reviewed and Ready to dispatch (A17, Q8).
- Reception "Log receipt" form for Staff (A20, Q3).
- Dispatch extras if needed (A18).

### Feature 14 — dsc-tracking (≈ 3–4 days, can run in parallel with 13: no shared tables)
- A DSC section under the client, tracking only, no password (A19, Q1, Q2): holder, class, issuer, expiry, token holder. Expiry reminder on Today and through Remind, **30 days ahead by default**, with a per-client setting in Client › Settings.

### Feature 15 — client-all-documents (≈ 3–4 days incl. the K4 fix)
- Client › **All documents** tab: the `/documents` table for this client, 20 per page, a Last activity column, expandable rows showing 5 events + "See all" (A11b).
- **K4** fix (index activity by document) first, since K4 also blocks rollout.

### Order and timing
- **Order:** 12 → (13 ∥ 14) → 15 → staging/prod → pilot.
- **Timing:** [Uncertain] ≈ 3–4 weeks + ≈ 1 week of staging.
- **Option to protect the December GST cycle:** ship 12 + 13 + 15, start the pilot, and land 14 (DSC) during the pilot. Only if Kushal can start without DSC.
- **Still required regardless:** the K3 performance fix before rollout to all clients.

## 4. Decisions — all answered 2026-10-29

Every question raised in this review has been answered, including the follow-ups on Q1 and Q8 (16:50); see **§0** for each decision and its effect. Nothing is waiting on Kushal's team.

## 5. Risks

- **Pilot date vs GST cycle.** [Likely] Q7 puts all of this before the pilot, so the first full cycle may be January. The two-drop option in §3 is the main lever.
- **"Document in office" adds a manual step to every hard copy** (Q8: returnable or not). If staff skip it, Today's "Ready to dispatch" goes stale. Mitigate with a bulk action on `/documents` and a Today count of originals stuck in office for more than N days.
- **Typed document types.** If typing created official types directly, "GSTR3B", "GSTR-3B" and "GST 3B" would become three types, and search, schedules and metric 1 would split. The type-ahead field keeps the approval queue, which prevents this.
- **Staff undoing reviews.** Low risk: every undo is logged in activity, and undoing a dispatch stays with Admin/Manager.

## 6. Next steps
1. **Raja:** approve this plan and the new pilot date (or the two-drop option).
2. **Walkthrough** with Sankar + Kushal (Step 0).
3. **Claude:** write the intent for **12-intake-review-fixes**, then spec → plan → build under the normal gates. Intents for 13, 14 and 15 follow.
4. **Roadmap:** add 12–15 to R1 with "from Kushal review 2026-10-29", and re-set the R1 pilot date.
