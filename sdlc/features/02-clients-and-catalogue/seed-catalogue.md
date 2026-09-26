# Seed catalogue — 02-clients-and-catalogue
Status: draft · Generic Indian CA catalogue (intent decision 1). The CA overrides anything in Settings › Catalogue.
**Schedule = when the firm needs the document from the client**, as offsets from the **end of the period**: `+A/a` = ask on day *a* of the A-th month after period end; `+O/o` = overdue from day *o*. Yearly types count from FY end (31 Mar): +2/15 = 15 June.
Statutory anchor = the filing it feeds (verified 2026-09-26; see Sources). Overdue is set before the anchor to leave working time.

| Group | Type | Aliases | Period kind | Freq | Ask | Overdue | Rem. | Statutory anchor |
|---|---|---|---|---|---|---|---|---|
| GST | Sales invoices / sales register | Outward supplies | month | monthly | +1/1 | +1/5 | on | GSTR-1: 11th (QRMP 13th after qtr) |
| GST | Purchase invoices / purchase register | Inward supplies | month | monthly | +1/1 | +1/10 | on | GSTR-3B: 20th (QRMP 22nd/24th) |
| GST | Credit / debit notes | | month | monthly | +1/1 | +1/5 | on | GSTR-1 |
| GST | E-way bills | | month | as needed | — | — | off | — |
| GST | Annual GST data (GSTR-9 / 9C) | GSTR-9, GSTR-9C | year | yearly | +8/1 | +8/30 | on | GSTR-9/9C: 31 Dec |
| GST | GST notice / order | | none | as needed | — | — | off | — |
| GST | GST working (firm) | | month | monthly | — | — | off | internal |
| TDS/TCS | Salary details for TDS | Payroll for TDS | month | monthly | +1/1 | +1/3 | on | TDS deposit: 7th |
| TDS/TCS | Vendor payments subject to TDS | TDS deduction details | month | monthly | +1/1 | +1/3 | on | TDS deposit: 7th |
| TDS/TCS | TDS / TCS challans | Challan 281 | month | monthly | +1/8 | +1/12 | on | after deposit |
| TDS/TCS | Deductee PAN / lower-deduction certificates | | none | as needed | — | — | off | — |
| TDS/TCS | TDS return working (firm) | Form 24Q, 26Q, 27Q, 27EQ, Form 138, 140, 144, 143 | quarter | quarterly | — | — | off | Returns: 31 Jul / 31 Oct / 31 Jan / 31 May |
| TDS/TCS | TDS notice / default | | none | as needed | — | — | off | — |
| Income Tax | Form 16 (salary TDS certificate) | Form 130 | year | yearly | +2/16 | +3/10 | on | ITR-1/2: 31 Jul |
| Income Tax | Form 16A (non-salary TDS certificates) | Form 131 | quarter | quarterly | +2/1 | +2/20 | off | used at ITR |
| Income Tax | AIS / TIS / Form 26AS | 26AS, Annual Information Statement | year | yearly | +2/1 | +3/10 | off | ITR |
| Income Tax | Investment & deduction proofs | 80C, 80D proofs | year | yearly | +1/1 | +3/10 | on | ITR-1/2: 31 Jul |
| Income Tax | Capital gains statements | Broker P&L | year | yearly | +2/1 | +3/10 | on | ITR |
| Income Tax | House property / rent details | | year | yearly | +2/1 | +3/10 | on | ITR |
| Income Tax | Advance tax challans | | month | as needed | — | — | off | 15 Jun / Sep / Dec / Mar |
| Income Tax | ITR acknowledgement (firm) | ITR-V | year | yearly | — | — | off | internal |
| Income Tax | Income-tax notice / order | | none | as needed | — | — | off | — |
| Banking | Bank statement | | month | monthly | +1/1 | +1/7 | on | books / GST reco |
| Banking | Loan statement / interest certificate | | year | yearly | +1/1 | +2/15 | on | ITR / audit |
| Banking | Bank balance confirmation | | year | yearly | +1/1 | +1/30 | on | audit |
| Banking | FD / interest certificates | | year | yearly | +1/1 | +2/15 | on | ITR |
| ROC/MCA | Board / AGM minutes & notices | | year | yearly | +5/1 | +5/31 | on | AGM by 30 Sep |
| ROC/MCA | Shareholding & director details (MGT-7) | MGT-7, MGT-7A | year | yearly | +5/1 | +6/15 | on | MGT-7: 60 days after AGM |
| ROC/MCA | Deposit / loan details (DPT-3) | DPT-3 | year | yearly | +1/1 | +2/15 | on | DPT-3: 30 Jun |
| ROC/MCA | Director KYC details | DIR-3 KYC | year | yearly | +5/1 | +5/20 | on | 30 Sep |
| ROC/MCA | Statutory registers | | none | as needed | — | — | off | — |
| ROC/MCA | ROC notice / order | | none | as needed | — | — | off | — |
| Payroll | Salary register | | month | monthly | +1/1 | +1/3 | on | PF/ESI/TDS |
| Payroll | PF challan / ECR | | month | monthly | +1/16 | +1/20 | off | PF: 15th |
| Payroll | ESI challan | | month | monthly | +1/16 | +1/20 | off | ESI: 15th |
| Payroll | Professional tax challan | PT | month | as needed | — | — | off | state-specific |
| Audit | Trial balance & books of accounts | Tally backup at year end | year | yearly | +1/1 | +4/31 | on | Tax audit report: 30 Sep |
| Audit | Fixed asset register | | year | yearly | +1/1 | +4/31 | on | audit |
| Audit | Stock / inventory statement | | year | yearly | +1/1 | +1/15 | on | audit |
| Audit | Debtor / creditor confirmations | | year | yearly | +1/1 | +3/30 | on | audit |
| Audit | Signed financial statements (firm) | Balance sheet, P&L | year | yearly | — | — | off | internal |
| Accounting | Expense bills & vouchers | | month | monthly | +1/1 | +1/10 | on | books |
| Accounting | Cash / petty cash book | | month | monthly | +1/1 | +1/10 | on | books |
| Accounting | Accounting data backup | Tally backup | month | monthly | +1/1 | +1/15 | off | books |
| Registrations | PAN card | | none | as needed | — | — | off | — |
| Registrations | GST registration certificate | GST certificate, REG-06 | none | as needed | — | — | off | — |
| Registrations | TAN allotment letter | | none | as needed | — | — | off | — |
| Registrations | Incorporation / deed (COI, MOA/AOA, partnership or trust deed) | | none | as needed | — | — | off | — |
| Registrations | Udyam / MSME certificate | | none | as needed | — | — | off | — |
| Registrations | Other licences (Shops & Est., IEC, PT registration) | | none | as needed | — | — | off | — |
| Registrations | KYC of proprietor / partners / directors | | none | as needed | — | — | off | — |
| Other | Correspondence / miscellaneous | | none | as needed | — | — | off | — |

GST types have `registration_kind = gstin`, TDS/TCS types `tan` (one expected doc per registration in 04); others none.
"(firm)" types are documents the firm produces; they are catalogued for filing and search but have no ask/overdue and reminders off.
Groups enabled for new clients by default: **none** (staff tick groups on Add client) — the CA can switch on e.g. GST + Banking later.

## Sources (checked 2026-09-26)
- GST: GSTR-1 11th (QRMP 13th), GSTR-3B 20th (QRMP 22nd/24th), GSTR-9/9C 31 Dec — https://www.taxaj.com/gst-due-date-calendar
- TDS form renumbering under Income-tax Act 2025 (24Q→138, 26Q→140, 27Q→144, 27EQ→143, Form 16→130, 16A→131) — https://blog.tdsman.com/2026/06/new-tds-tcs-forms-it-act-2025-mapping-with-old-forms/ ; Q1 FY 2026-27 return due 31 Jul 2026 — https://taxupdate.in/income-tax/811/new-tds-tcs-return-forms-fy-2026-27-form-138-140-143-144-due-31-july-2026/
- ITR (FY 2025-26): ITR-1/2 31 Jul, ITR-3/4 non-audit 31 Aug, audit 31 Oct — https://cleartax.in/s/due-date-tax-filing
- Not re-verified this session (standard, stable rules): TDS deposit 7th, PF/ESI 15th, DPT-3 30 Jun, AGM by 30 Sep, MGT-7 60 days after AGM, DIR-3 KYC 30 Sep. [Likely] — CA to confirm at gate.
