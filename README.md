# CA Document Vault

Document collection and vault for **Kushal Associates** (Pondicherry). Staff-only web app: Next.js 16 on Vercel (Mumbai, `bom1`) + Supabase (Mumbai, `ap-south-1`).
Product docs: `sdlc/product/` · Working rules for Claude: `CLAUDE.md` · Review checklist: `REVIEW.md`.

## Environments
| Env | Supabase project | Data |
|---|---|---|
| dev | `dev - CA Document Vault` (ysddbwskljzhbjjohool) · Vercel `ca-document-vault` → https://ca-document-vault.vercel.app (team `cad-oc-vault`) | synthetic only; all automated tests run here |
| staging | `staging - CA Document Vault` | created before the pilot; migrations rehearsed here |
| prod | `prod - CA Document Vault` | the only place real client data lives |

## Run locally
1. Node 22+. `npm ci`
2. Copy `.env.example` to `.env.local` and fill the values for **dev** (never prod).
3. `npm run dev` → http://localhost:3000

## Checks
`npm run lint && npm run typecheck && npm test && npm run build` · `npm run test:db` (dev DB) · `npm run test:e2e` (Playwright).
Tests use fixed test offices (`e2e office …`) and reusable test users on the reserved `.test` domain (reset each run; no emails are ever sent to them), so they never touch real users and the database does not fill up. Only the invite test adds one new user per run. Staff/audit rows cannot be deleted by design; see "Dev maintenance".

## Create a new environment (staging / prod) — target < 30 min
1. **Supabase** (org Pulsebay, region **ap-south-1**): create `<env> - CA Document Vault`. Plan: Pro for prod (backups).
2. **Auth settings**: Authentication → Sign In / Providers → turn **off** "Allow new users to sign up". Emails → *Magic Link* and *Invite user* templates must show `{{ .Token }}` (6-digit code). URL configuration → Site URL = the env's app URL. For staging/prod configure **custom SMTP** (AWS SES ap-south-1) — Supabase's built-in email only delivers to project team members.
3. **Schema**: apply every file in `supabase/migrations/` in order (Supabase CLI `supabase db push --db-url …` or the SQL editor). Staging first, always.
4. **First Admin**: Authentication → Users → Invite the Admin's email, then run in the SQL editor:
   ```sql
   insert into public.staff_user (id, office_id, full_name, email, role, status)
   select u.id, (select id from public.office where branch <> 'test' order by created_at limit 1), '<Full name>', lower(u.email), 'admin', 'invited'
   from auth.users u where lower(u.email) = lower('<admin email>');
   ```
5. **Vercel**: use a **separate Vercel project per environment** (e.g. `ca-document-vault` = dev, `ca-document-vault-prod` = prod) so dev and prod keys never share a project. In each, set env vars for **Production + Preview** scopes (Vercel's "Development" scope is only for `vercel dev` on a laptop): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (server-only). Region is pinned by `vercel.json` (`bom1`).
6. **Verify**: Security Advisor shows no RLS warnings; Admin signs in with a code; `/settings/users` loads.

## Dev maintenance
Test offices accumulate in dev (rows are never deleted by design). To purge them occasionally, a project owner runs in the **dev** SQL editor only: disable the `*_no_delete`/`activity_append_only` triggers, delete rows whose office name starts with `e2e office`, re-enable triggers. Never on staging/prod.
