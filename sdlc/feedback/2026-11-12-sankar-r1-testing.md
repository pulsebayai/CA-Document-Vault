# Sankar — R1 testing feedback (2026-11-12) and what was done

Source: three WhatsApp screenshots from Sankar (Pulsebay), 2026-11-12 06:45–06:53 IST.

| # | Feedback | Cause | Fix |
|---|---|---|---|
| 1 | Add DSC: "Show password" button is misaligned (wraps into two lines, sits off the field); use an eye icon instead of text. | `dsc-view.tsx` put a small text button beside the input in a flex row. | Eye icon button inside the field (slashed eye when shown). Accessible name stays "Show password" with `aria-pressed`, so screen readers and the existing e2e selectors are unchanged. |
| 2 | Today's "In office" card is empty (fine: nothing to act on), but the client page should list all hard copies the firm holds. | Today only lists copies that need an action; a filed copy had no view. | New client tab **In office** (`?tab=office`, spec 13 AC-21/22): every physical hard copy with a custody step and not in a live packet (includes copies showing Needs correction / To review), any FY, uncapped query, longest held first; same rows and actions as the Documents tab. No migration. No count on the tab label. |
| 3 | All documents tab defaults to the current FY, so documents with no financial year are hidden (tab said 2, list showed 1). | 15 AC-2 chose "current FY by default"; `search_documents` `fy` matches `period.financial_year` only. | **All years by default** (Sankar's first suggestion). An FY is now a filter the user picks. Spec 15 AC-2 updated; tests updated (scope-url, all-documents-view, e2e all-documents). |

Open point: picking a specific FY still hides documents with no FY. Acceptable (it is what a filter means); a later option is an "No financial year" entry in the FY select.

## Review
Opus reviewed both spec changes on 2026-11-12: approve with changes. Applied: filter by custody (not shown state), `listHeldDocuments` (no explicit limit; `max_rows` 1000 applies), 13 AC-21/22, 15 AC-1/AC-2/AC-4 + intent Q2 + architecture + ui-reference wording. Still to do: e2e `in-office.spec.ts` (run locally first), a 13 plan addendum step, move to a chore branch, re-run the release gate for the next R1 release.
