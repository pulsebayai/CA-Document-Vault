// Feature 19 — add, deactivate or reactivate a super admin in one environment (operator tool; spec Y1, AC-1). Run
// from a shell that has that environment's values (service role), e.g. after `set -a; . ./.env.staging; set +a`:
//   node scripts/add-platform-admin.mjs --env staging --email name@pulsebay.com --name "Full Name"   # prints the plan
//   …same… --yes                                                                                         # does it
//   node scripts/add-platform-admin.mjs --env staging --email name@pulsebay.com --deactivate --yes
// Logic: scripts/platform-admin-core.mjs (unit-tested).
import { createClient } from "@supabase/supabase-js";
import { USAGE, describePlan, parseArgs, run } from "./platform-admin-core.mjs";

const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}
const o = parsed.opts;
for (const line of describePlan(o)) console.log(line);
if (!o.yes) {
  console.log("\nNothing written. Check the lines above, then run again with --yes.");
  process.exit(0);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
try {
  const { id, result } = await run(db, o);
  console.log(`\nSuper admin ${result}: ${id}.${result === "added" && !o.test ? " Tell them to sign in at the vault's login page with the email code." : ""}`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}
