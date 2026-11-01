import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { feed } from "../support/activity";
import { K4_TARGET, activityCount, k4Office, medianMs, type K4Ctx } from "../support/k4";

// Feature 15 (spec AC-8, AC-9, U6) — K4 at volume: ≈ 200k activity rows in one office (tests/support/k4.ts, seeded
// once, shared by lanes). Measured 2026-11-01 before the fix (09's volume office, `explain analyze`): Staff ≈ 0.5 s,
// Limited 19.8 s (over the 8 s statement limit, so the card errors). Budget: round trip < 1 s, median of 5 warm calls
// (02's clients-list rule; the session's bare round trip to dev is ≈ 0.3 s).

let k: K4Ctx;

beforeAll(async () => {
  k = await k4Office();
  console.info("k4 office", { activity: await activityCount(k.officeId), seeded: k.seeded });
}, 600_000);

const card = (who: "staff" | "limited", documentId: string, limit = 20) => async () => {
  const { error } = await feed(k.as[who], { document_id: documentId, limit });
  if (error) throw new Error(error);
};

describe("K4 at ≈ 200k activity rows (AC-8, AC-9)", () => {
  it("the office holds the target volume", async () => {
    expect(await activityCount(k.officeId)).toBeGreaterThanOrEqual(K4_TARGET);
  });

  for (const who of ["staff", "limited"] as const) {
    it(`${who}: the document Activity card (20) and the expanded row (5) each < 1 s, for a real document and one with no events`, async () => {
      const t = {
        card: await medianMs(card(who, k.documentId)),
        expanded: await medianMs(card(who, k.documentId, 5)),
        empty: await medianMs(card(who, randomUUID())),
      };
      console.info(`k4 ${who} (ms)`, Object.fromEntries(Object.entries(t).map(([a, b]) => [a, Math.round(b)])));
      expect(t.card).toBeLessThan(1000);
      expect(t.expanded).toBeLessThan(1000);
      expect(t.empty).toBeLessThan(1000);
    }, 120_000);

    it(`${who}: Last activity for a page of 20 documents < 1 s`, async () => {
      const ms = await medianMs(async () => {
        const { error } = await k.as[who].rpc("document_last_activity", { p_ids: k.pageIds });
        if (error) throw new Error(error.message);
      });
      console.info(`k4 ${who} last activity (ms)`, Math.round(ms));
      expect(ms).toBeLessThan(1000);
    }, 120_000);
  }
});
