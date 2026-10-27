import { config } from "dotenv";

// Local runs read .env.local; CI provides the same names as GitHub secrets.
config({ path: ".env.local", quiet: true });

for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`Missing ${name}: DB tests need a Supabase project (dev via .env.local, or the local stack: scripts/local-db.sh).`);
}
