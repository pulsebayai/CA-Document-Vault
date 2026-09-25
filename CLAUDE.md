# CA Document Vault — working rules for Claude
@AGENTS.md
@sdlc/product/product.md
@sdlc/product/architecture.md
@sdlc/product/roadmap.md

## Active feature
Determined by branch: a branch containing <NN-slug> → sdlc/features/<NN-slug>/. At session start read its plan.md (checkboxes + latest session log). On main: product-level work only.

## Verification commands (must all pass before a step is done)
- npm run lint → 0 errors
- npm run typecheck → 0 errors
- npm run test → all pass
- npm run test:e2e → all pass
- npm run build → exits 0
(Scripts are created in 01-walking-skeleton.)

## Rules
- Follow the AI-native SDLC session start/end routines.
- Never edit a test to make it pass; fix the code.
- Never work directly on main except roadmap/product docs.
- On a feature branch, do not edit roadmap.md, and edit architecture.md only if this feature holds the architecture lock.
- Only the feature holding the schema lock may add database migrations.
- All data access goes through RLS-protected tables; never use the service-role key in client-reachable code.
- No PII (PAN, mobile, email, client names) in URLs, logs or analytics.
- Never hard-delete documents or clients (archive only).
- v1 is staff-only: no client-facing auth or links. The only client-facing outputs are staff-triggered reminders: email via SES and pre-filled WhatsApp click-to-chat (no attachments, no app links, no PAN/GSTIN). No automatic sends.
