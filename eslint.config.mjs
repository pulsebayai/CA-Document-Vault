import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SECRET_KEY_RULE = { selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='SUPABASE_SECRET_KEY']", message: "SUPABASE_SECRET_KEY may only be read in src/lib/supabase/admin.ts." };
const BREVO_KEY_RULE = { selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='BREVO_API_KEY']", message: "BREVO_API_KEY may only be read in src/lib/mail/brevo.ts (feature 06)." };

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Service-role (RLS-bypassing) client: only server-side modules listed below may import it.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/supabase/admin.ts", "src/lib/activity.ts", "src/lib/auth/actions.ts", "src/lib/auth/lockout.ts", "src/lib/auth/finish.ts", "src/lib/staff/actions.ts", "src/lib/documents/storage.ts", "src/app/(auth)/login/page.tsx"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "@/lib/supabase/admin", message: "Service-role client is restricted (see architecture.md). Add the file to the allow-list only after review." }] }],
      "no-restricted-syntax": ["error", { selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='SUPABASE_SECRET_KEY']", message: "SUPABASE_SECRET_KEY may only be read in src/lib/supabase/admin.ts." }],
    },
  },
  // Secrets fence (06 adds BREVO_API_KEY, read only in src/lib/mail/brevo.ts). A later block's
  // no-restricted-syntax replaces an earlier one for the same files, so both selectors are listed here and each
  // allowed file keeps the other fence. Effect: SUPABASE_SECRET_KEY only in admin.ts, BREVO_API_KEY only in brevo.ts.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/supabase/admin.ts", "src/lib/mail/brevo.ts"],
    rules: { "no-restricted-syntax": ["error", SECRET_KEY_RULE, BREVO_KEY_RULE] },
  },
  { files: ["src/lib/supabase/admin.ts"], rules: { "no-restricted-syntax": ["error", BREVO_KEY_RULE] } },
  { files: ["src/lib/mail/brevo.ts"], rules: { "no-restricted-syntax": ["error", SECRET_KEY_RULE] } },
  {
    // e2e specs use tests/e2e/fixtures.ts, which gives every browser context access to a protected Vercel preview.
    files: ["tests/e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "@playwright/test", message: "Import test/expect from ./fixtures (Vercel preview access for regression runs)." }] }],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);

export default eslintConfig;
