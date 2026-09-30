import { describe, expect, it } from "vitest";
import { adminClient } from "../support/db";

// Feature 04 — the daily job actually runs (spec NFR "Reliability", plan step 9). Nightly/release only
// (RUN_SLOW=1 in regression.yml): asserts the real dev office got its `expected.generated` row from the
// 00:15 IST pg_cron run within the last 26 hours. Test offices are excluded — they only run on the test clock.
// The volume measurements (~180k items) are deferred to the post-R1 volume test (Raja 2026-09-29).

describe.skipIf(!process.env.RUN_SLOW)("daily expected-documents job (nightly)", () => {
  it("ran for the real office within the last 26 hours", async () => {
    const admin = adminClient();
    const { data: offices, error } = await admin.from("office").select("id, name").eq("is_test", false).not("name", "like", "e2e office %");
    expect(error).toBeNull();
    expect(offices?.length ?? 0).toBeGreaterThan(0);
    const since = new Date(Date.now() - 26 * 3600_000).toISOString();
    for (const o of offices!) {
      const { data, error: e2 } = await admin.from("activity").select("created_at, actor_id")
        .eq("office_id", o.id).eq("action", "expected.generated").gte("created_at", since).limit(1);
      expect(e2).toBeNull();
      expect(data ?? [], `no expected.generated row in 26 h for office ${o.id}`).toHaveLength(1);
      expect(data![0].actor_id).toBeNull();
    }
  });
});
