import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);

export default eslintConfig;
