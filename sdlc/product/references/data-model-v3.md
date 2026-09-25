# CA India Document Management --- MVP Metadata & Data Model

## 1. Objective

Build a simple, dimension-driven document management system for Indian
Chartered Accountant (CA) firms.

The MVP must support:

-   Multiple clients per CA firm
-   Client-centric document management
-   Multiple views of the same documents
-   Compliance tracking and alerting
-   Document collection tracking
-   Future expansion without redesigning the core document model

The MVP should remain intentionally simple.

------------------------------------------------------------------------

## 2. MVP Core Dimensions

Every document should be classified using these six dimensions:

  ---------------------------------------------------------------------------
  \#                Dimension         Purpose               Example
  ----------------- ----------------- --------------------- -----------------
  1                 Client            Identifies which      ABC Pvt Ltd
                                      client owns the       
                                      document              

  2                 Financial Year    Identifies the        FY 2026-27
                                      financial year        
                                      relevant to the       
                                      document              

  3                 Document Group    Broad                 GST
                                      business/regulatory   
                                      category              

  4                 Document Type     Specific type of      GSTR-3B
                                      document              

  5                 Period            Period to which the   June 2026
                                      document relates      

  6                 Compliance        Compliance activity   GSTR-3B Filing
                                      associated with the   
                                      document              
  ---------------------------------------------------------------------------

### Design rule

A dimension should be modeled as a reusable master/reference entity, not
as free text embedded in every document record.

The document record should store foreign keys to the dimension records.

------------------------------------------------------------------------

# 3. Logical Data Model

``` text
dim_client
    |
    | client_id
    v
fact_document
    ^
    | fy_id
dim_financial_year

dim_document_group
    |
    | group_id
    v
fact_document

dim_document_type
    |
    | doc_type_id
    v
fact_document

dim_period
    |
    | period_id
    v
fact_document

dim_compliance
    |
    | compliance_id
    v
fact_document
```

Conceptually:

``` text
                         +----------------------+
                         |      dim_client      |
                         |----------------------|
                         | PK client_id         |
                         | client_code          |
                         | client_name          |
                         | partner_id           |
                         | manager_id           |
                         | status               |
                         +----------+-----------+
                                    |
                                    |
+----------------------+            |
| dim_financial_year   |            |
|----------------------|            |
| PK fy_id             |            |
| fy_code              |            |
| start_date           |            |
| end_date             |            |
| status                |            |
+----------+-----------+            |
           |                        |
           |                        |
           +------------+-----------+
                        |
                        v
              +----------------------+
              |    fact_document     |
              |----------------------|
              | PK document_id       |
              | FK client_id         |
              | FK fy_id             |
              | FK group_id          |
              | FK doc_type_id       |
              | FK period_id         |
              | FK compliance_id     |
              | file_name            |
              | storage_url/path     |
              | file_type            |
              | file_size            |
              | uploaded_by          |
              | uploaded_on          |
              | document_date        |
              | status               |
              | version              |
              | remarks              |
              +----------------------+
                        ^
                        |
           +------------+-------------+
           |                          |
           |                          |
+----------+-----------+   +----------+-----------+
| dim_document_group  |   | dim_document_type    |
|---------------------|   |-----------------------|
| PK group_id         |   | PK doc_type_id       |
| group_code          |   | FK group_id          |
| group_name          |   | type_code            |
| description         |   | type_name            |
| sort_order          |   | default_frequency    |
| status              |   | is_mandatory         |
+---------------------+   | status               |
                          +-----------------------+

+----------------------+       +----------------------+
| dim_period           |       | dim_compliance       |
|----------------------|       |----------------------|
| PK period_id         |       | PK compliance_id     |
| period_type          |       | compliance_code      |
| period_code          |       | compliance_name      |
| start_date           |       | regulatory_domain    |
| end_date             |       | frequency            |
| display_name         |       | default_due_rule     |
+----------------------+       | is_active            |
                               +----------------------+
```

------------------------------------------------------------------------

# 4. Dimension Definitions

## 4.1 Client

Represents a client served by the CA firm.

### MVP attributes

``` text
client_id
client_code
client_name
partner_id
manager_id
status
```

Example:

``` text
client_id   = C001
client_code = ABC001
client_name = ABC Pvt Ltd
```

Do not add every client identifier to the MVP document dimension unless
required.

PAN, GSTIN, TAN, CIN, etc. can be added later or maintained in a
separate client/entity model.

------------------------------------------------------------------------

## 4.2 Financial Year

Represents the financial year relevant to the document.

### MVP attributes

``` text
fy_id
fy_code
start_date
end_date
status
```

Example:

``` text
fy_id   = FY202627
fy_code = 2026-27
```

The model should not hard-code "Assessment Year" as the only concept.

Use a generic year/period model so that changes in Indian tax
terminology can be accommodated.

------------------------------------------------------------------------

## 4.3 Document Group

Broad classification of documents.

### Initial controlled values

``` text
GST
TDS / TCS
Income Tax
Banking
Registration & Licenses
Accounting
Audit
Payroll
MCA / ROC
Other
```

### MVP attributes

``` text
group_id
group_code
group_name
description
sort_order
status
```

Example:

``` text
group_id   = G001
group_code = GST
group_name = GST
```

------------------------------------------------------------------------

## 4.4 Document Type

Specific type of document.

### Examples

``` text
GST
  GSTR-1
  GSTR-3B
  GSTR-2B
  GST Registration Certificate

TDS
  TDS Return - 24Q
  TDS Return - 26Q
  Form 16
  Form 16A

Income Tax
  ITR
  Tax Computation
  Tax Audit Report

Banking
  Bank Statement
  Bank Confirmation
  Loan Statement
```

### MVP attributes

``` text
doc_type_id
group_id
type_code
type_name
default_frequency
is_mandatory
status
```

`default_frequency` is useful for compliance setup, but actual
compliance obligations should be stored separately.

------------------------------------------------------------------------

## 4.5 Period

Represents the time period to which the document relates.

### MVP attributes

``` text
period_id
period_type
period_code
start_date
end_date
display_name
```

### Examples

``` text
MONTH
2026-06
June 2026
```

``` text
QUARTER
FY2026-27-Q1
Q1 FY 2026-27
```

``` text
YEAR
FY2026-27
2026-27
```

A period should not be represented only as a string such as "June 2026".

Use `period_type + period_code`.

------------------------------------------------------------------------

# 5. Compliance Dimension

Compliance is slightly richer than the other MVP dimensions because it
drives alerting.

### MVP attributes

``` text
compliance_id
compliance_code
compliance_name
regulatory_domain
frequency
default_due_date_rule
is_active
```

Example:

``` text
compliance_id       = CMP001
compliance_code     = GSTR3B
compliance_name     = GSTR-3B Filing
regulatory_domain   = GST
frequency           = MONTHLY
default_due_date_rule = GST-specific rule
```

## Important architectural distinction

Do not store only a compliance master record and expect it to provide
alerts.

The system needs a **compliance obligation/instance** for a specific
client and period.

Example:

``` text
Client: ABC Pvt Ltd
Compliance: GSTR-3B Filing
Period: June 2026
Due Date: 20-Jul-2026
Status: Pending
```

This can later become:

``` text
compliance_obligation
---------------------
obligation_id
client_id
compliance_id
fy_id
period_id
due_date
status
completed_date
```

For the MVP, this can be implemented simply, but the distinction should
exist conceptually.

------------------------------------------------------------------------

# 6. Document Record

A document record should contain the document-specific information plus
references to the six dimensions.

Example:

``` text
document_id
client_id
fy_id
group_id
doc_type_id
period_id
compliance_id

file_name
storage_url/path
file_type
file_size

uploaded_by
uploaded_on
document_date

status
version
remarks
```

Example document:

``` text
document_id   = DOC000123

client_id     = C001
fy_id         = FY202627
group_id      = G001
doc_type_id   = DT_GSTR3B
period_id     = P202606
compliance_id = CMP001

file_name     = GSTR-3B_June_2026.pdf
file_type     = PDF
uploaded_by   = U123
uploaded_on   = 2026-07-05 10:30
status        = Received
version       = 1
```

------------------------------------------------------------------------

# 7. How Dimensions Help Data Storage

The dimensions provide standardized references rather than repeated
text.

Instead of storing:

``` text
client_name = "ABC Pvt Ltd"
document_group = "GST"
document_type = "GSTR-3B"
financial_year = "2026-27"
```

on every record, store:

``` text
client_id = C001
group_id = G001
doc_type_id = DT001
fy_id = FY202627
```

Benefits:

1.  **Consistency**
    -   Prevents variants such as `GST`, `GST Compliance`, `G.S.T.`.
2.  **Reduced duplication**
    -   Client and classification data are stored once.
3.  **Efficient filtering**
    -   Database indexes can operate on IDs.
4.  **Multiple viewpoints**
    -   The same document can be queried by client, FY, group, type,
        period or compliance.
5.  **Future extensibility**
    -   New dimensions can be added without changing existing document
        files.
6.  **Master-data governance**
    -   CA firm administrators can control valid clients, document
        groups and document types.

------------------------------------------------------------------------

# 8. Views Enabled by the Same Data

No physical folder hierarchy is required for these views.

## Client View

``` text
ABC Pvt Ltd
  └── FY 2026-27
       ├── GST
       ├── TDS
       ├── Income Tax
       ├── Banking
       └── Registration
```

## Document Group View

``` text
GST
  ├── ABC Pvt Ltd
  ├── XYZ Pvt Ltd
  └── Kumar & Co
```

## Document Type View

``` text
GSTR-3B
  ├── ABC Pvt Ltd — June 2026
  ├── XYZ Pvt Ltd — June 2026
  └── Kumar & Co — June 2026
```

## Period View

``` text
June 2026
  ├── GST documents
  ├── TDS documents
  ├── Bank documents
  └── Income Tax documents
```

## Compliance View

``` text
GSTR-3B Filing
  ├── Completed
  ├── Pending
  └── Overdue
```

------------------------------------------------------------------------

# 9. Example Queries

The dimension model should make these queries straightforward.

### All documents for a client

``` sql
SELECT *
FROM fact_document
WHERE client_id = 'C001';
```

### All GST documents for a client in FY 2026-27

``` sql
SELECT *
FROM fact_document
WHERE client_id = 'C001'
  AND fy_id = 'FY202627'
  AND group_id = 'G001';
```

### All GSTR-3B documents across clients

``` sql
SELECT *
FROM fact_document
WHERE doc_type_id = 'DT_GSTR3B';
```

### All June 2026 documents

``` sql
SELECT *
FROM fact_document
WHERE period_id = 'P202606';
```

### Compliance documents due soon

This should query compliance obligations, not merely uploaded documents.

``` sql
SELECT *
FROM compliance_obligation
WHERE due_date BETWEEN CURRENT_DATE
                   AND CURRENT_DATE + INTERVAL '7 days'
  AND status <> 'COMPLETED';
```

### Missing document

This is important:

A missing document does **not** exist in `fact_document`.

It is derived by comparing expected compliance/document requirements
against received documents.

``` text
Expected
    |
    | compare
    v
Received Documents
    |
    v
Missing / Pending Collection
```

------------------------------------------------------------------------

# 10. MVP UI Mapping

For CA firm users managing multiple clients:

``` text
Dashboard
│
├── Clients
│    └── Client workspace
│         ├── Documents
│         ├── Compliance
│         └── Document Collection
│
├── Compliance
│    ├── Due in 7 days
│    ├── Overdue
│    └── Completed
│
├── Document Collection
│    └── Pending documents by client
│
├── Documents
│    └── Search / filter across all dimensions
│
└── Masters
     ├── Clients
     ├── Financial Years
     ├── Document Groups
     ├── Document Types
     └── Compliance Types
```

------------------------------------------------------------------------

# 11. MVP vs Future

## MVP

``` text
Client
Financial Year
Document Group
Document Type
Period
Compliance
```

Plus basic document fields:

``` text
File
Title
Date
Status
Version
Uploaded By
Uploaded On
Remarks
```

## Later dimensions/attributes

Do not implement initially unless required:

``` text
PAN
GSTIN
TAN
CIN / LLPIN
Source
Engagement
Partner
Reviewer
Confidentiality
Retention
Workflow
Registration
Transaction
Evidence relationship
Document lineage
AI classification
```

These should be added without breaking the six-dimension model.

------------------------------------------------------------------------

# 12. Core Architectural Principle

The MVP should follow this rule:

``` text
                 DIMENSIONS
                     |
                     v
              +-------------+
              |  DOCUMENT   |
              +-------------+
                     |
                     v
              STORAGE SYSTEM
```

The **file itself is not the classification system**.

The database metadata determines how the file can be discovered and
viewed.

Therefore:

> **One physical document + one metadata record → unlimited logical
> views.**

This is the central reason to use dimensions rather than a traditional
nested folder structure.

------------------------------------------------------------------------

# 13. Recommended MVP Boundary

Do not build a generic ontology engine yet.

Build:

``` text
6 fixed MVP dimensions
        +
simple master tables
        +
document metadata table
        +
compliance obligation table
        +
search/filter
        +
client-centric dashboard
        +
compliance alerts
        +
document collection
```

The database and API should nevertheless use IDs and relationships so
that a seventh dimension can be introduced later without restructuring
the entire system.

# 14. MVP Metadata Capture Without OCR

## Objective

The MVP should avoid requiring users to manually enter all metadata fields.

> **The user should identify the document, not repeatedly classify it.**

Because OCR is not part of the MVP, metadata capture should rely on:

1. User context
2. Master data
3. Previous usage
4. User selection
5. AI suggestions only when the user introduces a new value

## 14.1 Client from Context

When the user uploads from a client workspace or client-specific collection request, `client_id` is inherited automatically.

```text
Clients
  ↓
ABC Pvt Ltd
  ↓
Upload Documents
  ↓
client_id = C001
```

A global upload screen can still ask the user to select the client.

## 14.2 Document Type Suggestions

Document Type should be the primary user-controlled classification.

Do not display the entire master list by default. Show frequently/recently used types for the selected client.

Initial ranking can be based on client usage frequency, user usage frequency, recent usage, and master priority. No AI is required for this ranking.

## 14.3 Existing Document Type

If the user searches for an existing type, show matching master values and let the user select one. No additional confirmation is required.

## 14.4 New Document Type with AI Suggestion

If the user enters a value that does not exist in the master, do not silently create an official master value.

Example:

```text
New document type entered:
GST Purchase Register

We could not find an exact match.

Did you mean:
● Purchase Register              91%
● GST Purchase Invoice           54%
● Input Tax Credit Statement     42%

[Use "GST Purchase Register"]
[Cancel]
```

AI is a suggestion mechanism, not the authority.

## 14.5 User Confirmation

If the user chooses to create the new value:

```text
Document Type:
GST Purchase Register

⚠ New document type

This will be sent to the administrator
for validation.

[Confirm & Submit]
```

The document upload is not blocked while waiting for administrator approval.

# 15. Temporary User-Proposed Document Types

A user-created value should not immediately become an official master value.

```text
MASTER
    Purchase Register

USER_PROPOSED
    GST Purchase Register

ADMIN_APPROVED
    GST Purchase Register
```

Use a separate `document_type_proposal` entity:

```text
document_type_proposal
-----------------------
proposal_id
user_id
client_id
entered_value
ai_suggestions
selected_value
status
admin_comment
created_at
resolved_at
```

Statuses:

```text
PENDING
APPROVED
MAPPED
REJECTED
```

# 16. Daily Administrator Review

Generate a daily report containing all new document types created by users.

Example:

```text
New Document Types — 10 Sep 2026

User    Client          New Type                  AI Suggestion
----------------------------------------------------------------
Ravi    ABC Pvt Ltd     GST Purchase Register     Purchase Register
Priya   XYZ Ltd         Bank Advice               Bank Statement
Arun    Kumar & Co      Sales Bill                Sales Invoice
```

Administrator actions:

```text
[Approve as New Type]
[Map to Existing Type]
[Edit & Approve]
[Reject]
```

The administrator should see the user, client, original value, AI suggestions, number of documents using it, possible equivalent master values, and creation date.

# 17. Mapping to an Existing Master Value

Example:

```text
User entered:
GST Purchase Register

Administrator decision:
Map → Purchase Register
```

Affected documents should use the approved master ID:

```text
doc_type_id = PURCHASE_REGISTER
```

The original input must remain in audit history:

```text
Original input:
GST Purchase Register

Admin decision:
Mapped → Purchase Register

Changed by:
Admin

Changed on:
10-Sep-2026
```

# 18. User Notification

If an administrator changes or maps a user's proposed value, notify the user through the notification center rather than a blocking popup.

Example:

```text
1 Metadata Update

Your document type:
"GST Purchase Register"

has been standardized by your administrator to:
"Purchase Register"

[View Details]
[Got it]
```

# 19. Complete MVP Flow

```text
                  USER
                    |
                    v
             Upload Document
                    |
                    v
             Determine Client
             from context
                    |
                    v
        Show frequently used types
                    |
          +---------+---------+
          |                   |
       Existing              New
          |                   |
          v                   v
       Select          AI suggestions
                              |
                              v
                       User confirms
                              |
                              v
                     Temporary proposal
                              |
                              v
                           Submit
                              |
                              v
                    Daily Admin Review
                              |
                     +--------+--------+
                     |        |        |
                     v        v        v
                  Approve    Map     Reject
                     |        |        |
                     +--------+--------+
                              |
                              v
                       Master Taxonomy
                              |
                              v
                  Future upload suggestions
```

# 20. Metadata Automation Priority

```text
1. Context
   Client workspace / collection request
             ↓
2. Master relationships
   Document Type → Document Group / Compliance
             ↓
3. Usage history
   Frequently used document types
             ↓
4. AI suggestion
   Only for new/ambiguous user-entered values
             ↓
5. User confirmation
   Final authority
             ↓
6. Admin governance
   Master taxonomy validation
```

## Core Principle

> **Existing values should be easy to select; new values should be easy to create but controlled by administration.**

For the MVP, implement this pattern primarily for **Document Type**. Later it can be extended to Document Group, Compliance, and other controlled metadata.

# 21. Revised MVP Direction — Document Collection, Not Compliance Management

## 21.1 Product Objective

The MVP is a **client document collection system** for CA firms.

The primary user question is:

> **What documents do I still need to collect from this client?**

The system should not expose compliance-management complexity to the user in the MVP.

Therefore, **Compliance is removed from the primary MVP workflow and metadata model** unless a future requirement explicitly brings it back.

---

## 21.2 Simple User Experience

The primary workflow is:

```text
LOGIN
  ↓
MY TODO
  ↓
CLIENT
  ↓
WHAT DOCUMENTS ARE REQUIRED?
  ↓
WHAT IS MISSING?
  ↓
REQUEST / UPLOAD
  ↓
RECEIVED
```

Recommended primary navigation:

```text
My TODO
Clients
Documents
Collection Lists
Notifications
Admin
```

The user should interact primarily with TODO items rather than metadata fields.

---

## 21.3 Revised MVP Metadata Dimensions

The core document metadata remains dimension-driven, but the MVP uses **five dimensions**:

| Dimension | Purpose | Example |
|---|---|---|
| Client | Identifies the client | ABC Pvt Ltd |
| Financial Year | Identifies the relevant FY | FY 2026-27 |
| Document Group | Broad category | GST |
| Document Type | Specific document | GSTR-3B |
| Period | Relevant period | June 2026 |

The system may still maintain other non-dimensional document attributes such as file name, upload date, status, version, etc.

---

# 22. Collection Requirement — Central MVP Object

The most important architectural addition is **Collection Requirement**.

A Collection Requirement represents an expected document for a specific client/context.

Example:

```text
Collection Requirement
----------------------
requirement_id : CR001
client_id      : C001
financial_year : FY2026-27
document_group : Banking
document_type  : Bank Statement
period         : 2026-06
status         : PENDING
```

The user sees only:

```text
□ Bank Statement — June 2026
```

The metadata is maintained behind the scene.

---

## 22.1 Expected vs Actual

The system must distinguish between:

### Expected document

Stored as a `collection_requirement`.

```text
ABC Pvt Ltd
June 2026
Bank Statement
EXPECTED
```

### Actual document

Stored as a `document`.

```text
ABC Pvt Ltd
FY 2026-27
Banking
Bank Statement
June 2026
RECEIVED
```

The requirement becomes satisfied when a matching document is received.

---

## 22.2 TODO is a Derived View

Do not store TODO as a primary classification field.

Conceptually:

```text
EXPECTED COLLECTION REQUIREMENTS
              MINUS
RECEIVED DOCUMENTS
              =
PENDING TODO
```

Example:

```text
Expected
----------------
Bank Statement
Purchase Invoices
Sales Invoices
GSTR-2B

Received
----------------
Bank Statement
GSTR-2B

TODO
----------------
□ Purchase Invoices
□ Sales Invoices
```

This keeps the data model clean and makes the TODO dynamically accurate.

---

# 23. Collection Plan

A Client can have one or more Collection Plans.

Example:

```text
ABC Pvt Ltd
  ↓
Monthly Collection Plan
  ↓
June 2026
  ├── Bank Statement
  ├── Purchase Invoices
  ├── Sales Invoices
  ├── GSTR-2B
  └── TDS Challans
```

A Collection Plan produces Collection Requirements for a client and period.

Recommended conceptual structure:

```text
collection_plan
----------------
collection_plan_id
client_id
financial_year_id
period_id
plan_name
status
created_at
created_by
```

```text
collection_requirement
----------------------
requirement_id
collection_plan_id
client_id
financial_year_id
document_group_id
document_type_id
period_id
status
received_document_id
created_at
completed_at
```

---

# 24. Document Data Model

The actual document should retain the five core dimension references.

```text
document
--------------------------
document_id              PK
client_id                FK
financial_year_id        FK
document_group_id        FK
document_type_id         FK
period_id                FK

file_name
storage_url
file_type
file_size
document_date
uploaded_by
uploaded_on
status
version
remarks
```

Conceptually:

```text
Collection Requirement
        │
        │ expects
        ▼
    Document
        │
        │ satisfies
        ▼
Collection Requirement
```

The document can therefore be searched by all five metadata dimensions even though the user never manually entered them during upload.

---

# 25. Metadata Population from User Flow

The user should not be asked to enter all five dimensions.

## 25.1 Context First

If the user is inside a client workspace:

```text
Clients
  ↓
ABC Pvt Ltd
  ↓
June 2026 Collection
  ↓
Bank Statement
  ↓
Upload
```

The system already knows:

```text
client          = ABC Pvt Ltd
financial_year  = FY 2026-27
period          = June 2026
document_type   = Bank Statement
document_group  = Banking
```

The user only chooses the file.

---

## 25.2 Document Type as the Main User Classification

When the user must classify a document, provide suggestions based on:

```text
Client usage history
User usage history
Recent usage
Master priority
```

Example:

```text
Document Type

Suggested for ABC Pvt Ltd:

● GSTR-3B
● GSTR-1
● Bank Statement
● Purchase Invoice
● Sales Invoice

[Search all document types...]
[+ Add new document type]
```

---

# 26. New Document Type Governance

The system must allow users to introduce new document types without immediately changing the official master list.

Workflow:

```text
User enters new type
        ↓
AI compares against master list
        ↓
AI presents suggestions
        ↓
User chooses existing type OR confirms new type
        ↓
Document is submitted
        ↓
New type enters proposal queue
        ↓
Daily Admin Review
```

AI is only a suggestion engine. The user makes the immediate classification decision and the administrator governs the master taxonomy.

---

# 27. Document Type Proposal

Recommended entity:

```text
document_type_proposal
-----------------------
proposal_id
user_id
client_id
entered_value
ai_suggestions
selected_value
status
admin_comment
created_at
resolved_at
```

Statuses:

```text
PENDING
APPROVED
MAPPED
REJECTED
```

---

# 28. Administrative Governance Flow

Every day, the administrator reviews new document types.

Example:

```text
User    Client          Proposed Type
----------------------------------------------
Ravi    ABC Pvt Ltd     GST Purchase Register
Priya   XYZ Industries  Bank Advice
Arun    Kumar & Co      Sales Bill
```

For each item, the administrator can:

```text
Approve as New Type
Map to Existing Type
Edit & Approve
Reject
```

If the administrator maps:

```text
GST Purchase Register
        ↓
Purchase Register
```

all affected documents should use the approved master ID while preserving the original user input in audit history.

---

# 29. User Notification After Admin Change

If an administrator changes or maps a proposed type, notify the user through the notification center.

Example:

```text
Metadata Update

Your document type:
"GST Purchase Register"

has been standardized to:
"Purchase Register"

[View Details]
[Got it]
```

Do not use a blocking popup as the normal login experience.

---

# 30. Revised MVP Architecture

The overall architecture should now be:

```text
                        CLIENT
                           │
                           ▼
                  COLLECTION PLAN
                           │
                           ▼
              COLLECTION REQUIREMENT
                           │
            ┌──────────────┴──────────────┐
            │                             │
         EXPECTED                    RECEIVED
            │                             │
            │                             ▼
            │                         DOCUMENT
            │                             │
            │                    ┌────────┼────────┐
            │                    │        │        │
            │                    ▼        ▼        ▼
            │                   FY      TYPE     PERIOD
            │                            │
            │                            ▼
            │                           GROUP
            │
            └──────────── comparison ────────► TODO
```

The **Collection Requirement** is the expectation layer.

The **Document** is the actual storage/classification layer.

The **TODO** is the derived operational view.

---

# 31. Key UX Principle

The user should think:

> **What do I need from this client?**

not:

> **Which metadata fields do I need to fill?**

The application should therefore make metadata mostly implicit through context and collection requirements.

```text
USER ACTION
Select client / open TODO
       ↓
Select requirement
       ↓
Upload file
       ↓
Done

BACKEND ACTION
Resolve requirement
       ↓
Assign five dimensions
       ↓
Store document
       ↓
Mark requirement RECEIVED
       ↓
Remove item from TODO
       ↓
Make document searchable
```

This provides a simple TODO-style experience while preserving structured, governed, multi-dimensional document storage.
