# Seed catalogue — 02-clients-and-catalogue
Status: approved (rev 2, 2026-09-26, Raja) · Generic Indian CA catalogue (intent decision 1). The CA overrides anything in Settings › Document catalogue.

**What this list is:** the documents the firm needs **from the client** to do the client's work. Every row is named after **what the client hands over**. The return or form it feeds is only a secondary note ("Used for").
**What it is not:** a list of returns the firm files. The firm's own outputs (returns filed, acknowledgements, signed financials) are in the separate **Firm records** list at the end. They have no schedule, no reminders, and are never chased from the client.

**Schedule = when the firm needs the document from the client**, as offsets from the **end of the period**: `+A/a` = ask on day *a* of the A-th month after period end; `+O/o` = overdue from day *o*. Yearly types count from FY end (31 Mar): +2/15 = 15 June. Overdue is set before the filing due date so there is time to work.

## A. Client documents (`source = client`)

| Group | Document the client gives us | Aliases | Period | Freq | Ask | Overdue | Rem. | Used for (filing, due date) |
|---|---|---|---|---|---|---|---|---|
| GST | Sales invoices / sales register | Outward supplies | month | monthly | +1/1 | +1/5 | on | GSTR-1: 11th (QRMP 13th after qtr) |
| GST | Purchase invoices / purchase register | Inward supplies | month | monthly | +1/1 | +1/10 | on | GSTR-3B: 20th (QRMP 22nd/24th); ITC check |
| GST | Credit / debit notes issued and received | | month | monthly | +1/1 | +1/5 | on | GSTR-1 / GSTR-3B |
| GST | E-way bills | | month | as needed | — | — | off | GSTR-1 reconciliation |
| GST | GST notice / order received | | none | as needed | — | — | off | reply to department |
| TDS/TCS | Salary paid to employees (for TDS) | Payroll for TDS | month | monthly | +1/1 | +1/3 | on | TDS deposit 7th; quarterly return Form 138 (old 24Q) |
| TDS/TCS | Payments to vendors / contractors / rent / professionals | TDS deduction details | month | monthly | +1/1 | +1/3 | on | TDS deposit 7th; quarterly return Form 140 (old 26Q) |
| TDS/TCS | TDS / TCS payment challans (if the client pays) | Challan 281 | month | monthly | +1/8 | +1/12 | on | quarterly TDS/TCS return |
| TDS/TCS | Deductee PAN / lower-deduction certificates | | none | as needed | — | — | off | correct TDS rate |
| TDS/TCS | TDS notice / default received | | none | as needed | — | — | off | reply / correction |
| Income Tax | Form 16 from employer | Form 130 | year | yearly | +2/16 | +3/10 | on | ITR-1/2: 31 Jul |
| Income Tax | Form 16A from deductors | Form 131 | quarter | quarterly | +2/1 | +2/20 | off | ITR (TDS credit) |
| Income Tax | AIS / TIS / Form 26AS (client sends, or firm downloads with client's login) | 26AS, Annual Information Statement | year | yearly | +2/1 | +3/10 | off | ITR (income + TDS check) |
| Income Tax | Investment & deduction proofs | 80C, 80D proofs | year | yearly | +1/1 | +3/10 | on | ITR-1/2: 31 Jul |
| Income Tax | Capital gains statement from broker / fund house | Broker P&L | year | yearly | +2/1 | +3/10 | on | ITR |
| Income Tax | Rent received / home-loan interest details | House property | year | yearly | +2/1 | +3/10 | on | ITR |
| Income Tax | Advance tax challans (if the client paid) | | month | as needed | — | — | off | ITR (tax credit) |
| Income Tax | Income-tax notice / order received | | none | as needed | — | — | off | reply to department |
| Banking | Bank statement | | month | monthly | +1/1 | +1/7 | on | books; GST reconciliation |
| Banking | Loan statement / interest certificate | | year | yearly | +1/1 | +2/15 | on | ITR / audit |
| Banking | Bank balance confirmation | | year | yearly | +1/1 | +1/30 | on | audit |
| Banking | FD / interest certificates | | year | yearly | +1/1 | +2/15 | on | ITR |
| ROC/MCA | Board & general meeting minutes and notices | | year | yearly | +5/1 | +5/31 | on | annual accounts & return filing (AGM by 30 Sep) |
| ROC/MCA | Shareholding changes & share transfer details | | year | yearly | +5/1 | +6/15 | on | annual return MGT-7 / 7A (60 days after AGM) |
| ROC/MCA | Loans & deposits outstanding at 31 Mar (lender list, amounts) | | year | yearly | +1/1 | +2/15 | on | DPT-3: 30 Jun |
| ROC/MCA | Director KYC details (PAN, Aadhaar, mobile, email) | | year | yearly | +5/1 | +5/20 | on | DIR-3 KYC: 30 Sep |
| ROC/MCA | Statutory registers | | none | as needed | — | — | off | ROC compliance |
| ROC/MCA | ROC notice / order received | | none | as needed | — | — | off | reply to ROC |
| Payroll | Salary register / attendance | | month | monthly | +1/1 | +1/3 | on | PF, ESI, TDS |
| Payroll | PF payment challan (if the client pays) | | month | monthly | +1/16 | +1/20 | off | PF: 15th |
| Payroll | ESI payment challan (if the client pays) | | month | monthly | +1/16 | +1/20 | off | ESI: 15th |
| Payroll | Professional tax challan | PT | month | as needed | — | — | off | state PT return |
| Audit | Trial balance & books of accounts | Tally backup at year end | year | yearly | +1/1 | +4/31 | on | tax audit (30 Sep) / ITR |
| Audit | Fixed asset purchase & sale details | Asset register | year | yearly | +1/1 | +4/31 | on | audit; depreciation |
| Audit | Closing stock statement | Inventory | year | yearly | +1/1 | +1/15 | on | audit |
| Audit | Debtor / creditor balance confirmations | | year | yearly | +1/1 | +3/30 | on | audit |
| Accounting | Expense bills & vouchers | | month | monthly | +1/1 | +1/10 | on | books |
| Accounting | Cash / petty cash book | | month | monthly | +1/1 | +1/10 | on | books |
| Accounting | Accounting data backup | Tally backup | month | monthly | +1/1 | +1/15 | off | books |
| Registrations | PAN card | | none | as needed | — | — | off | KYC |
| Registrations | GST registration certificate | GST certificate, REG-06 | none | as needed | — | — | off | KYC |
| Registrations | TAN allotment letter | | none | as needed | — | — | off | KYC |
| Registrations | Incorporation / deed (COI, MOA/AOA, partnership or trust deed) | | none | as needed | — | — | off | KYC |
| Registrations | Udyam / MSME certificate | | none | as needed | — | — | off | KYC |
| Registrations | Other licences (Shops & Est., IEC, PT registration) | | none | as needed | — | — | off | KYC |
| Registrations | KYC of proprietor / partners / directors | | none | as needed | — | — | off | KYC |
| Other | Correspondence / miscellaneous from client | | none | as needed | — | — | off | — |

GST client documents have `registration_kind = gstin`, TDS/TCS client documents `tan` (04 expects one per active registration); all others none.

## B. Firm records (`source = firm`) — kept for filing and search only

Not documents the client gives us. No ask/overdue, reminders off (DB check), never copied into a client's collection plan, never "expected" or overdue.

| Group | Firm record | Aliases (for search) | Period |
|---|---|---|---|
| GST | GST returns filed & acknowledgements | GSTR-1, GSTR-3B, GSTR-9, GSTR-9C | month |
| GST | GST working / reconciliation | | month |
| TDS/TCS | TDS / TCS returns filed & acknowledgements | Form 138, 140, 143, 144, 24Q, 26Q, 27Q, 27EQ | quarter |
| TDS/TCS | TDS certificates issued to deductees | Form 16, 16A, Form 130, 131 | quarter |
| Income Tax | ITR filed & acknowledgement | ITR-V | year |
| Income Tax | Computation of income | | year |
| Audit | Signed financial statements | Balance sheet, P&L | year |
| Audit | Tax audit report | 3CA, 3CB, 3CD | year |
| ROC/MCA | ROC filings & challans | AOC-4, MGT-7, DPT-3, DIR-3 KYC | year |

Groups enabled for new clients by default: **none** (staff tick groups on Add client; decided at spec gate 2026-09-26).

## Changes from rev 1 (CA feedback at spec gate)
- Rows renamed from the filing to the document the client gives ("Deposit / loan details (DPT-3)" → "Loans & deposits outstanding at 31 Mar"; "Shareholding & director details (MGT-7)" → "Shareholding changes & share transfer details"; etc.). "Statutory anchor" column → "Used for".
- "Annual GST data (GSTR-9 / 9C)" removed: its inputs are the year's books (Audit › Trial balance) and the returns already filed (firm record).
- "(firm)" rows moved to section B with explicit `source = firm`; added "Computation of income", "Tax audit report", "ROC filings", "TDS certificates issued".
- Challans stay in Part A: usually the client pays and sends the challan (confirmed by Raja at gate). If the firm pays for a particular client, staff remove that type for that client.

## Sources (checked 2026-09-26)
- GST: GSTR-1 11th (QRMP 13th), GSTR-3B 20th (QRMP 22nd/24th), GSTR-9/9C 31 Dec — https://www.taxaj.com/gst-due-date-calendar
- TDS form renumbering under Income-tax Act 2025 (24Q→138, 26Q→140, 27Q→144, 27EQ→143, Form 16→130, 16A→131) — https://blog.tdsman.com/2026/06/new-tds-tcs-forms-it-act-2025-mapping-with-old-forms/ ; Q1 FY 2026-27 return due 31 Jul 2026 — https://taxupdate.in/income-tax/811/new-tds-tcs-return-forms-fy-2026-27-form-138-140-143-144-due-31-july-2026/
- ITR (FY 2025-26): ITR-1/2 31 Jul, ITR-3/4 non-audit 31 Aug, audit 31 Oct — https://cleartax.in/s/due-date-tax-filing
- Not re-verified (standard, stable rules): TDS deposit 7th, PF/ESI 15th, DPT-3 30 Jun, AGM by 30 Sep, MGT-7 60 days after AGM, DIR-3 KYC 30 Sep. [Likely] — CA to confirm.
