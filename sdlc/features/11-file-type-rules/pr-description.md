# feat(11): preferred file formats per document type

Kushal Associates asked for a preferred file format per document type (e.g. Excel for bank statements), with per-client exceptions. **Advisory only: nothing is ever refused for its format.** Clients (upload page) and staff get a warning and can upload anyway; a file outside the preference is flagged "Not preferred format" for review and can be filtered on `/documents`.

Spec: `sdlc/features/11-file-type-rules/spec.md` (AC-1…AC-24) · Plan: `plan.md` (deviations listed there) · Architecture: `architecture.md` › "Preferred file formats (11)".

## What changes
- **Schema** (migrations A `20261026082819`, A2 `20261026084429`, B `20261026113420`, C `20261026114801`; all applied on dev, live function bodies = files):
  - `doc_type.preferred_formats` (allow-list minus ZIP);
  - `client_doc_type.any_format`, the per client + type exception (Staff+);
  - the format-check snapshot on `document` (`format_preferred`, `format_ok`), set in 03's `document_before_write`;
  - the seed for six types (real office only);
  - search filter and facet;
  - `link_open` `preferred`, plus `link_register` `warned` (written only when true);
  - `format_metric`.
- **UI:**
  - Settings › Catalogue "Preferred formats";
  - the Client › Settings switch;
  - the staff warning (Add document / Edit / Upload for item / Add version);
  - the badge on Client › Documents, `/documents` and the document page;
  - the `/documents` Format filter;
  - the `/u` hint and warning ("Choose another file" / "Upload anyway");
  - the Settings › Collection "Preferred formats" section.
- **Permissions matrix:** +1 row ("Allow any format for a client + type"), probed in `role-matrix`.

## AC → test → result
| AC | What | Test | Result |
|---|---|---|---|
| 1–2 | Type dialog, rules (subset, distinct, approved only) | `format-preferences` (RLS), e2e `format-preferences` AC-1 | ✅ |
| 3 | Activity on change | `format-preferences`; feed coverage unit test | ✅ |
| 4 | Seed for six types (real office; test offices opt in) | `format-preferences` | ✅ |
| 5–8 | Client exception: shown, Staff+ only, logged, only where a preference exists | `format-preferences`, `role-matrix`, e2e AC-5/AC-20 | ✅ |
| 9–10 | `/u` hint and warning; Choose another / Upload anyway; announced | e2e `upload-link-formats` (390 px + axe) | ✅ |
| 11 | Nothing refused for format | `format-check`, `format-reads`, e2e | ✅ |
| 12 | `link_open` `preferred` (absent with an exception, never says why) | `format-reads` | ✅ |
| 13 | `warned` on the link-upload row only when true | `format-reads`, e2e `upload-link-formats` | ✅ |
| 14 | Check set by the DB on every filing path (staff, link, item, version, re-classify) | `format-check` | ✅ |
| 15 | Check can't be set from the app | `format-check` | ✅ |
| 16 | Badge and detail | e2e `format-preferences` AC-16 | ✅ |
| 17 | Flag changes nothing else (To review, linked, received) | `format-check` (added in review) | ✅ |
| 18 | Preferred new version clears the flag | `format-check` | ✅ |
| 19–20 | Staff warning, two-step "Allow any format", announced | unit `format-warning`, e2e AC-19 | ✅ |
| 21–22 | `/documents` filter/facet; visibility unchanged (Limited) | `format-reads`, e2e AC-21 | ✅ |
| 23 | Activity IDs/codes only; feed sentences | `format-preferences`, feed coverage unit test | ✅ |
| 24 | Settings › Collection figures | `format-reads`, e2e AC-24 | ✅ |
| — | 10's tests unedited | all `upload-links-*` RLS + e2e green | ✅ |

## Evidence
- **CI 40454733549 (attempt 2) green on 35ef103**, the last commit (06 test-helper fix + docs on top of 9523b70). Attempt 1 failed only 02's `clients-list` timing check (4.0 s first page; 271 ms on re-run): a dev-database stall. Earlier: CI 40362710004 green on 9523b70 (11's last code change); CI 40448990859 on f9ab6b7 failed 06's `follow-up.test.ts` AC-17 because lane 1's office had passed PostgREST's 1,000-row cap, fixed in the test helper (35ef103, approved by Raja).
- **RUN_SLOW Regression 40396660735** on the branch preview (9523b70):
  - Unit ✅ · **RLS incl. RUN_SLOW ✅** (incl. `documents-perf`: 03's save timing with the format check in the trigger) · e2e 121 ✅ / 3 ❌.
  - The three failures were preview setup, not 11:
    1. `LINK_IP_SALT` was missing on Vercel. With `MAIL_TRANSPORT=brevo` on Preview, every link action fails closed, so 10's and 11's `/u` tests failed.
    2. 10's cron smoke test can't pass Vercel's protection on previews (its request client never gets the bypass cookie).
- **Fix:** `LINK_IP_SALT` added (Production + Preview), preview and main redeployed. **Quick check 40442859475: `upload-link` files 21/21 ✅** ("Quick check — not release evidence").
- **Pre-PR review** (sdlc-reviewer): no blockers; 3 Important findings fixed, each with a test that failed first; nits recorded in `plan.md`.

## After merge
- Roadmap on main: 11 shipped, locks released; R1 checklist: staging shows the six seeded format types after the replay; `LINK_IP_SALT` on every Vercel environment.
- Later list: cron smoke bypass on previews; 10's fake-token e2e step never reloads the page (fragment-only navigation).
- Full RUN_SLOW Regression on main; tonight's nightly is the first deployed run of the `/u` tests on main.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01NJNSFVKjKXfT6CB3osEdX2
