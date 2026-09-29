// Test lanes (chore test-isolation, 2026-09-29): lets up to three CI/Regression runs share the dev database.
//   node scripts/test-lane.mjs acquire   → leases a free lane (waits for one), exports TEST_LANE to later steps
//   node scripts/test-lane.mjs release   → gives it back (run with `if: always()`; a crashed run's lease expires)
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY (service role; the lane functions refuse everyone else)
// and TEST_LANE_HOLDER (unique per job run, e.g. "<workflow>-<run_id>-<attempt>").
import { appendFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const minutes = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const WAIT_MINUTES = minutes("TEST_LANE_WAIT_MINUTES", 30);
// Must outlast the longest job (ci.yml 55 min, regression.yml 75 min incl. the wait) — else another run could
// take the lane mid-test. Raise it together with any job timeout.
const LEASE_MINUTES = minutes("TEST_LANE_LEASE_MINUTES", 90);
const POLL_SECONDS = 20;

const holder = process.env.TEST_LANE_HOLDER?.trim();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!holder || !url || !key) {
  console.error("::error::test-lane needs TEST_LANE_HOLDER, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  for (let attempt = 1; ; attempt++) {
    const { data, error } = await db.rpc("acquire_test_lane", { p_holder: holder, p_minutes: LEASE_MINUTES })
      .then((r) => r, (e) => ({ data: null, error: e }));
    if (error) console.log(`::warning::acquire_test_lane failed (${error.message}); retrying.`);
    else if (data !== null) {
      console.log(`Test lane ${data} leased to ${holder} for ${LEASE_MINUTES} min.`);
      if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `TEST_LANE=${data}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Test lane: **${data}**\n\n`);
      return;
    }
    if (Date.now() >= deadline) {
      console.error(`::error::All test lanes stayed busy for ${WAIT_MINUTES} min. Re-run this job when another run finishes.`);
      process.exit(1);
    }
    if (attempt === 1) console.log(`All test lanes are busy; waiting up to ${WAIT_MINUTES} min…`);
    await sleep(POLL_SECONDS * 1000);
  }
}

async function release() {
  const lane = Number(process.env.TEST_LANE);
  if (!Number.isInteger(lane) || lane < 1) {
    console.log("No test lane held by this job; nothing to release.");
    return;
  }
  const { data, error } = await db.rpc("release_test_lane", { p_lane: lane, p_holder: holder })
    .then((r) => r, (e) => ({ data: null, error: e }));
  // Never turn a green run red over the release: the lease expires on its own.
  if (error) return console.log(`::warning::release_test_lane failed (${error.message}); lane ${lane} will expire with its lease.`);
  console.log(data ? `Test lane ${lane} released.` : `Test lane ${lane} was no longer held by ${holder} (lease expired?).`);
}

const cmd = process.argv[2];
if (cmd === "acquire") await acquire();
else if (cmd === "release") await release();
else {
  console.error("usage: node scripts/test-lane.mjs acquire|release");
  process.exit(1);
}
