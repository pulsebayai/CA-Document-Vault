# UI reference — mockup as source of truth
Source: https://cavault.pulsebay.com (prototype v2), captured 2026-09-25 → `mockup/*.jpg`.
Rule: build screens to match the mockup (layout, components, copy, tokens) **except** the deviations below. Accessibility (WCAG 2.1 AA) wins over pixel fidelity.

## Design tokens (extracted from mockup CSS)
| Token | Value | Use |
|---|---|---|
| --canvas | #F5F6F8 | page background |
| --panel | #FFFFFF | cards, header (header at 92% opacity) |
| --ink / --ink-2 / --ink-3 | #181C24 / #565D6B / #8A909D | text: primary / secondary / muted (DOC ids, meta) |
| --line / --line-2 | #E6E8EC / #D5D8DF | dividers / input & secondary-button borders |
| --accent / --accent-soft | #2E5BA8 / #EAF0FA | primary buttons, links / avatar, selected |
| --ok / --ok-soft | #22754F / #E4F2EA | reviewed, success |
| --warn / --warn-soft | #B0611A / #FBEFE2 | due soon, hard copy, waiting |
| --bad / --bad-soft | #B23A3A / #FBE9E9 | overdue, Original badge, Inbox count |
| --sh | 0 1px 2px rgba(24,28,36,.04), 0 4px 14px rgba(24,28,36,.05) | card shadow |

- Font: **IBM Plex Sans** (fallback -apple-system, Segoe UI, sans-serif); body 14.5px/400; H1 22px/600; meta 13–13.5px; badges 12px/500.
- Header: 56px, white 92%, padding 0 24px; brand (icon + firm name) left; nav pills (active = ink background, white text, radius ~8px); search (with "/" hint) + primary "+ Add document" + avatar initials right.
- Primary button: accent bg, white, radius 9px, padding 8px 14px, 500. Small buttons: 13px, radius 7px, padding 4px 10px, height 30px; secondary = white + 1px --line-2.
- Badges/pills: radius 99px, padding 2px 8px, soft background + strong text.
- Cards: white, radius ~12px, --sh shadow, rows separated by --line.
- Content: full-width grids (Today, Clients, Client detail) or centred ~815px column (Inbox, Activity, Add document); Settings = left sub-nav + content.

## Agreed deviations from the mockup
| Mockup | Product | Decided |
|---|---|---|
| Delete documents/clients (Admin, Manager) | Archive (reversible, logged) | 2026-09-25 |
| Office › "Let clients upload through the link" | Removed — no client links in v1 | 2026-09-25 |
| Reminders › automatic ask/nudge/weekly repeat | Manual "Remind" only; automatic later | 2026-09-25 |
| Acknowledgement emails (received / dispatched) | Later | 2026-09-25 |
| Client › "Send upload link" button | Removed | 2026-09-25 |
| Remind = email | Email **+ WhatsApp** (click-to-chat) button | 2026-09-25 |
| Proposed types: Approve / Merge / Reject | + Edit & approve; in-app notification to proposer | 2026-09-25 |
| Screens appear all at once | Nav items appear as their feature ships (no dead links) | 2026-09-25 |
| Muted text --ink-3 #8A909D (3.3:1) | Darkened to ≥ 4.5:1 for text < 18px | 2026-09-25 |
| Brand "Sharma & Co" | "Kushal Associates" · Pondicherry | 2026-09-25 |
| Warning token --warn #B0611A (4.06:1 on --warn-soft) | Darkened to #9C5717 (WCAG AA) | 2026-09-28 (03) |
| Header at phone width | ≤ 390 px: nav scrolls sideways, office name hidden below md, "Add document" shows as "+" (with accessible name) | 2026-09-28 (03) |
| Header search (mockup 01: box with "/" hint, no dropdown shown) | Combobox dropdown with **Clients** and **Documents** groups (≤ 5 each) and "See all results for '…'"; a complete DOC-ID + Enter opens the document. Below 640 px the box is a **Search** icon button that opens a full-width field with a Close button | 2026-09-29/30 (03b) |
| No documents results screen in the mockup | **`/documents`** (no nav item): title + "N documents", a search field, filter dropdowns showing counts ("Channel: Courier (12)"), removable filter chips + "Clear all", rows in 03's Inbox row style, Previous/Next paging. On phones a "Filters" button shows or hides the filter panel in place (no full-screen sheet) | 2026-09-30 (03b) |
| Filter chips open popovers (Clients screen style) | `/documents` filters are native selects styled as chips, not popovers: same values and counts, keyboard/screen-reader access built in | 2026-09-30 (03b) |
| 10 Client › Documents: card header "GST · Priya · Monthly · 14 documents" | "N open · N documents"; the assignee shows on Expected rows and in Settings | 2026-10-01 (04) |
| 10: "Due today" as orange text; Remind / Mark received / review states | "Overdue" / "Due today" / "Due" badges + "Not received · …" text; Remind (06) and review/dispatch states (07) come later | 2026-10-01 (04) |
| 10: "10 more · Show all" | At most 5 open rows per card, then "N more open · Show all on Expected" | 2026-10-01 (04) |
| 03 Clients: "1 overdue · reminders off"; active chip dark with × | "N overdue · N due today" (reminders text with 06); "Has overdue" is a toggle chip (pressed state, cleared by Clear) | 2026-10-01 (04) |
| (no mockup) Client › Expected tab, Settings › Collection | Built from the design tokens and existing card/table patterns (04 AC-13, AC-16) | 2026-10-01 (04) |
