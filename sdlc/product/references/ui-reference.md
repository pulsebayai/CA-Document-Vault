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
| Screens appear all at once | Nav items appear as their feature ships (no dead links) | spec 01 |
