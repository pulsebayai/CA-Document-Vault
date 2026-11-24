import { describe, expect, it } from "vitest";
import {
  decideNightlyMode, findLastGreenFullSha, isGreenFullRun, istWeekday, nightlyInputs, resolveNightlyMode,
} from "../../scripts/nightly-mode.mjs";

// Chore test-volume (2026-11-24): the scheduled nightly runs the full suite on hosted dev only when main changed
// since the last green full run, and every Sunday (IST); other nights a read-only dev smoke. Dispatches are unchanged.
const MAIN = "70c396f0000000000000000000000000000000aa";
const OTHER = "1234567000000000000000000000000000000bb";
const base = { event: "schedule", mainSha: MAIN, lastGreenFullSha: MAIN, istWeekday: "Mon", override: "" };

describe("decideNightlyMode — the rules", () => {
  it("a schedule on unchanged main, not Sunday → smoke", () => {
    expect(decideNightlyMode(base)).toBe("smoke");
  });

  it("anything but a schedule → full (dispatches are unchanged)", () => {
    for (const event of ["workflow_dispatch", "push", "pull_request", "", undefined]) {
      expect(decideNightlyMode({ ...base, event }), String(event)).toBe("full");
    }
  });

  it("an override wins on a schedule", () => {
    expect(decideNightlyMode({ ...base, override: "full" })).toBe("full");
    expect(decideNightlyMode({ ...base, mainSha: OTHER, override: "smoke" })).toBe("smoke");
    expect(decideNightlyMode({ ...base, lastGreenFullSha: null, istWeekday: "Sun", override: "smoke" })).toBe("smoke");
  });

  it("an override never turns a non-schedule into smoke", () => {
    expect(decideNightlyMode({ ...base, event: "workflow_dispatch", override: "smoke" })).toBe("full");
  });

  it("an unknown override is ignored (the rules decide)", () => {
    expect(decideNightlyMode({ ...base, override: "auto" })).toBe("smoke");
    expect(decideNightlyMode({ ...base, override: "bogus", mainSha: OTHER })).toBe("full");
  });

  it("no green full run found → full", () => {
    expect(decideNightlyMode({ ...base, lastGreenFullSha: null })).toBe("full");
    expect(decideNightlyMode({ ...base, lastGreenFullSha: "" })).toBe("full");
  });

  it("main changed since the last green full run → full", () => {
    expect(decideNightlyMode({ ...base, mainSha: OTHER })).toBe("full");
  });

  it("no main SHA known → full", () => {
    expect(decideNightlyMode({ ...base, mainSha: "" })).toBe("full");
  });

  it("Sunday (IST) → full", () => {
    expect(decideNightlyMode({ ...base, istWeekday: "Sun" })).toBe("full");
  });

  it("every other weekday on unchanged main → smoke", () => {
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) expect(decideNightlyMode({ ...base, istWeekday: d }), d).toBe("smoke");
  });

  it("a target other than dev is always full, override or not", () => {
    for (const target of ["staging", "prod"]) {
      expect(decideNightlyMode({ ...base, target }), target).toBe("full");
      expect(decideNightlyMode({ ...base, target, override: "smoke" }), target).toBe("full");
    }
  });
});

describe("istWeekday", () => {
  it("uses the date in India, not UTC", () => {
    expect(istWeekday(new Date("2026-11-22T18:29:00Z"))).toBe("Sun"); // 23:59 IST Sun 2026-11-22
    expect(istWeekday(new Date("2026-11-22T18:30:00Z"))).toBe("Mon"); // 00:00 IST Mon 2026-11-23
    expect(istWeekday(new Date("2026-11-24T04:40:00Z"))).toBe("Tue"); // 10:10 IST Tue 2026-11-24 (today's late nightly)
  });
});

describe("nightlyInputs — which event and override the rules see", () => {
  it("a schedule passes through with no override", () => {
    expect(nightlyInputs({ eventName: "schedule", target: "", nightlyMode: "" })).toEqual({ event: "schedule", override: "", target: "dev" });
  });

  it("a dispatch with target staging or prod stays a dispatch (→ full, the existing path, never smoke-dev)", () => {
    for (const target of ["staging", "prod"]) {
      for (const nightlyMode of ["auto", "full", "smoke", ""]) {
        const inputs = nightlyInputs({ eventName: "workflow_dispatch", target, nightlyMode });
        expect(inputs.event, `${target}/${nightlyMode}`).toBe("workflow_dispatch");
        expect(decideNightlyMode({ ...base, ...inputs }), `${target}/${nightlyMode}`).toBe("full");
      }
    }
  });

  it("a dev dispatch with nightly_mode full|smoke is treated as a schedule with that override (proof tool)", () => {
    expect(nightlyInputs({ eventName: "workflow_dispatch", target: "dev", nightlyMode: "smoke" })).toEqual({ event: "schedule", override: "smoke", target: "dev" });
    expect(nightlyInputs({ eventName: "workflow_dispatch", target: "", nightlyMode: "full" })).toEqual({ event: "schedule", override: "full", target: "dev" });
  });

  it("an ordinary dev dispatch (nightly_mode auto or unset) stays a dispatch → full", () => {
    for (const nightlyMode of ["auto", "", undefined]) {
      const inputs = nightlyInputs({ eventName: "workflow_dispatch", target: "dev", nightlyMode });
      expect(decideNightlyMode({ ...base, ...inputs }), String(nightlyMode)).toBe("full");
    }
  });
});

// Shapes as the GitHub REST API returns them (only the fields the script reads).
type Step = { name: string; conclusion: string | null };
type Job = { name: string; conclusion: string | null; steps?: Step[] };
type Run = { id: number; head_sha: string; head_branch: string; event: string; status: string; conclusion: string | null; created_at: string };

const fullSteps = (rls = "success", e2e = "success"): Step[] => [
  { name: "Check the target's settings", conclusion: "skipped" },
  { name: "Check the quick-check filter", conclusion: "skipped" },
  { name: "RLS (database security)", conclusion: rls },
  { name: "E2E (full) against deployed URL", conclusion: e2e },
  { name: "Smoke only (prod — no data-writing tests)", conclusion: "skipped" },
];
const regressionJob = (conclusion: string | null, steps: Step[] = fullSteps()): Job => ({ name: "regression", conclusion, steps });
const smokeRunJobs = (): Job[] => [
  { name: "plan", conclusion: "success" },
  { name: "regression", conclusion: "skipped", steps: [] },
  { name: "smoke-dev", conclusion: "success" },
];
const run = (id: number, sha: string, created: string, extra: Partial<Run> = {}): Run => ({
  id, head_sha: sha, head_branch: "main", event: "schedule", status: "completed", conclusion: "success", created_at: created, ...extra,
});

function fakeApi(runs: Run[], jobs: Record<number, Job[]>) {
  const calls: number[] = [];
  return {
    calls,
    getRuns: async () => runs,
    getJobs: async (id: number) => { calls.push(id); return jobs[id] ?? []; },
  };
}

describe("isGreenFullRun", () => {
  it("the job named regression concluded success on a full dev run", () => {
    expect(isGreenFullRun([regressionJob("success")])).toBe(true);
  });

  it("a red, cancelled or skipped regression job is not green", () => {
    for (const c of ["failure", "cancelled", "skipped", null]) expect(isGreenFullRun([regressionJob(c)]), String(c)).toBe(false);
  });

  it("smoke runs don't count (regression skipped, smoke-dev green)", () => {
    expect(isGreenFullRun(smokeRunJobs())).toBe(false);
  });

  it("a quick check (only = …), a staging run or a prod smoke is not a full dev run", () => {
    const quick = fullSteps().map((s) => (s.name === "Check the quick-check filter" ? { ...s, conclusion: "success" } : s));
    const staging = fullSteps().map((s) => (s.name === "Check the target's settings" ? { ...s, conclusion: "success" } : s));
    const prod = fullSteps("skipped", "skipped").map((s) => (s.name.startsWith("Smoke only") ? { ...s, conclusion: "success" } : s));
    expect(isGreenFullRun([regressionJob("success", quick)])).toBe(false);
    expect(isGreenFullRun([regressionJob("success", staging)])).toBe(false);
    expect(isGreenFullRun([regressionJob("success", prod)])).toBe(false);
  });

  it("no jobs → not green", () => {
    expect(isGreenFullRun([])).toBe(false);
  });
});

describe("findLastGreenFullSha", () => {
  it("returns the newest green full run's commit on main", async () => {
    const api = fakeApi(
      [run(3, MAIN, "2026-11-24T04:40:00Z"), run(2, MAIN, "2026-11-23T05:00:00Z"), run(1, OTHER, "2026-11-10T05:00:00Z")],
      { 3: smokeRunJobs(), 2: [regressionJob("success")], 1: [regressionJob("success")] },
    );
    expect(await findLastGreenFullSha(api)).toBe(MAIN);
  });

  it("skips runs not on main (branch dispatches) and runs still in progress", async () => {
    const api = fakeApi(
      [run(4, OTHER, "2026-11-24T06:00:00Z", { head_branch: "chore/test-volume", event: "workflow_dispatch" }),
       run(3, OTHER, "2026-11-24T05:00:00Z", { status: "in_progress", conclusion: null }),
       run(2, MAIN, "2026-11-23T05:00:00Z")],
      { 4: [regressionJob("success")], 3: [regressionJob(null)], 2: [regressionJob("success")] },
    );
    expect(await findLastGreenFullSha(api)).toBe(MAIN);
  });

  it("looks at the last 30 runs only", async () => {
    const runs = Array.from({ length: 40 }, (_, i) => run(100 - i, i === 35 ? MAIN : OTHER, `2026-11-${String(24 - Math.floor(i / 2)).padStart(2, "0")}T05:00:00Z`));
    const jobs: Record<number, Job[]> = {};
    for (const r of runs) jobs[r.id] = r.head_sha === MAIN ? [regressionJob("success")] : [regressionJob("failure")];
    const api = fakeApi(runs, jobs);
    expect(await findLastGreenFullSha(api)).toBeNull();
    expect(api.calls.length).toBeLessThanOrEqual(30);
  });

  it("no green full run → null", async () => {
    const api = fakeApi([run(1, MAIN, "2026-11-24T05:00:00Z", { conclusion: "failure" })], { 1: [regressionJob("failure")] });
    expect(await findLastGreenFullSha(api)).toBeNull();
  });
});

// The plan says "Mon Nov 24 / Sun Nov 23"; on the calendar 2026-11-24 is a Tuesday and the Sunday is 2026-11-22.
const NOV_24_TUE = new Date("2026-11-24T04:40:00Z"); // 10:10 IST
const NOV_22_SUN = new Date("2026-11-22T03:40:00Z"); // 09:10 IST
const env = (extra: Record<string, string> = {}) => ({ GITHUB_EVENT_NAME: "schedule", GITHUB_SHA: MAIN, ...extra });

describe("resolveNightlyMode — API + rules together", () => {
  // Nov 17: first green full run on 70c396f; every night since ran on the same commit.
  const history = () => fakeApi(
    [run(9, MAIN, "2026-11-24T04:40:00Z", { status: "in_progress", conclusion: null }),
     run(8, MAIN, "2026-11-22T03:40:00Z", { conclusion: "failure" }),
     run(2, MAIN, "2026-11-17T05:00:00Z"),
     run(1, MAIN, "2026-11-16T05:00:00Z", { conclusion: "failure" })],
    { 9: [regressionJob(null)], 8: [regressionJob("failure")], 2: [regressionJob("success")], 1: [regressionJob("failure")] },
  );

  it("history: green full run on 70c396f (Nov 17) → Tue 2026-11-24 IST is smoke", async () => {
    expect((await resolveNightlyMode({ env: env(), now: NOV_24_TUE, api: history() })).mode).toBe("smoke");
  });

  it("history: Sun 2026-11-22 IST is full", async () => {
    expect((await resolveNightlyMode({ env: env(), now: NOV_22_SUN, api: history() })).mode).toBe("full");
  });

  it("a red full run on unchanged main → the next night is full again (no green full run on that commit)", async () => {
    const api = fakeApi(
      [run(5, MAIN, "2026-11-25T05:00:00Z", { conclusion: "failure" }), run(4, OTHER, "2026-11-20T05:00:00Z")],
      { 5: [regressionJob("failure")], 4: [regressionJob("success")] },
    );
    expect((await resolveNightlyMode({ env: env(), now: new Date("2026-11-26T05:00:00Z"), api })).mode).toBe("full");
  });

  it("any API failure → full (the current behaviour)", async () => {
    const failingRuns = { getRuns: async () => { throw new Error("HTTP 502"); }, getJobs: async () => [] };
    const failingJobs = { getRuns: history().getRuns, getJobs: async () => { throw new Error("HTTP 403"); } };
    for (const api of [failingRuns, failingJobs]) {
      const r = await resolveNightlyMode({ env: env(), now: NOV_24_TUE, api });
      expect(r.mode).toBe("full");
      expect(r.reason).toMatch(/API/i);
    }
  });

  it("a dispatch with target staging or prod → full without asking the API", async () => {
    for (const TARGET of ["staging", "prod"]) {
      const api = { getRuns: async () => { throw new Error("must not be called"); }, getJobs: async () => [] };
      const r = await resolveNightlyMode({ env: env({ GITHUB_EVENT_NAME: "workflow_dispatch", TARGET, NIGHTLY_MODE: "smoke" }), now: NOV_24_TUE, api });
      expect(r.mode, TARGET).toBe("full");
    }
  });

  it("an ordinary dev dispatch → full", async () => {
    const r = await resolveNightlyMode({ env: env({ GITHUB_EVENT_NAME: "workflow_dispatch", TARGET: "dev", NIGHTLY_MODE: "auto" }), now: NOV_24_TUE, api: history() });
    expect(r.mode).toBe("full");
  });

  it("a dev proof dispatch with nightly_mode=smoke → smoke, even on a branch commit", async () => {
    const r = await resolveNightlyMode({ env: env({ GITHUB_EVENT_NAME: "workflow_dispatch", TARGET: "dev", NIGHTLY_MODE: "smoke", GITHUB_SHA: OTHER }), now: NOV_22_SUN, api: history() });
    expect(r.mode).toBe("smoke");
  });
});
