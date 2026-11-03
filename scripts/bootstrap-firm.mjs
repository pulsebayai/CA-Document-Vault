// Feature 17 — set up a firm in one environment (operator tool; spec AC-14–18). Run from a shell that has that
// environment's values (service role), e.g. after `set -a; . ./.env.staging; set +a`:
//   node scripts/bootstrap-firm.mjs --env staging --name "Kushal Associates" --branch "Pondicherry" \
//     --admin-email admin@firm.in --admin-name "Admin Name"            # prints the plan
//   …same… --yes                                                         # does it
// Logic: scripts/bootstrap-core.mjs (unit-tested).
import { createClient } from "@supabase/supabase-js";
import { USAGE, describePlan, parseArgs, runBootstrap } from "./bootstrap-core.mjs";

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
  const { officeId, result } = await runBootstrap(db, o);
  console.log(`\nFirm ${result}: office ${officeId}. First Admin ${o.test ? "created (test, no email)" : "invited by email"}.`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}
