#!/usr/bin/env node
// Chore test-volume (2026-11-24): decide whether tonight's scheduled Regression runs the full suite on hosted dev
// or only a read-only dev smoke. The full nightly rewrote ~4,000 clients and made ~18,500 API calls every night on
// an unchanged main, and exhausted dev's Disk IO budget (dev down ~1 h on 2026-11-24).
//
// Rules (plan step 1; decisions 1–2, owner 2026-11-24):
//   not a schedule → full (dispatches are unchanged) · target other than dev → full · override full|smoke wins ·
//   no green full run found → full · main changed since the last green full run → full · Sunday (IST) → full ·
//   otherwise smoke.
// "Green full run" = a regression.yml run on main whose job named `regression` concluded success as a full dev run
// (not a quick check, a staging run or a prod smoke); smoke runs don't count. The last 30 runs are read.
// Any API failure → full (fail safe = the behaviour before this chore).
//
// Usage in CI: GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo GITHUB_EVENT_NAME=… GITHUB_SHA=… [TARGET=dev]
//   [NIGHTLY_MODE=auto|full|smoke] node scripts/nightly-mode.mjs   → appends mode=full|smoke to $GITHUB_OUTPUT
import { appendFileSync } from "node:fs";

const OVERRIDES = new Set(["full", "smoke"]);
const RUNS_LOOKED_AT = 30;
const WORKFLOW = "regression.yml";
const JOB = "regression";
// Step names in regression.yml's `regression` job that mark a run as something other than a full dev run.
const NOT_FULL_STEPS = [/^Check the quick-check filter$/, /^Check the target's settings$/, /^Smoke only/];

/** The weekday ("Mon" … "Sun") of the date in India (IST, UTC+5:30). */
export function istWeekday(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(date);
}

/**
 * "full" | "smoke" for one Regression run.
 * @param {{ event?: string, mainSha?: string, lastGreenFullSha?: string | null, istWeekday?: string, override?: string, target?: string }} p
 */
export function decideNightlyMode({ event, mainSha, lastGreenFullSha, istWeekday: weekday, override, target }) {
  if (event !== "schedule") return "full";
  if (target && target !== "dev") return "full";
  if (override && OVERRIDES.has(override)) return override;
  if (!lastGreenFullSha) return "full";
  if (!mainSha || mainSha !== lastGreenFullSha) return "full";
  if (weekday === "Sun") return "full";
  return "smoke";
}

/**
 * Maps the workflow's event and inputs to what the rules see. A dev dispatch with nightly_mode full|smoke is a proof
 * tool for this chore and is treated as a schedule with that override; every other dispatch stays a dispatch (full).
 * @param {{ eventName?: string, target?: string, nightlyMode?: string }} p
 */
export function nightlyInputs({ eventName, target, nightlyMode }) {
  const t = target || "dev";
  if (eventName === "workflow_dispatch" && t === "dev" && nightlyMode && OVERRIDES.has(nightlyMode)) {
    return { event: "schedule", override: nightlyMode, target: t };
  }
  return { event: eventName ?? "", override: "", target: t };
}

/** True when the run's `regression` job concluded success as a full dev run. */
export function isGreenFullRun(jobs) {
  const job = (jobs ?? []).find((j) => j.name === JOB);
  if (!job || job.conclusion !== "success") return false;
  const ranNotFullStep = (job.steps ?? []).some((s) => s.conclusion === "success" && NOT_FULL_STEPS.some((re) => re.test(s.name)));
  return !ranNotFullStep;
}

/**
 * The head SHA of the newest green full run on main among the last 30 runs, or null.
 * @param {{ getRuns: () => Promise<any[]>, getJobs: (runId: number) => Promise<any[]> }} api
 */
export async function findLastGreenFullSha(api, { branch = "main" } = {}) {
  const runs = (await api.getRuns())
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, RUNS_LOOKED_AT);
  for (const run of runs) {
    if (run.head_branch !== branch || run.status !== "completed") continue;
    if (isGreenFullRun(await api.getJobs(run.id))) return run.head_sha;
  }
  return null;
}

/** GitHub REST reads for the rules (no writes). */
export function githubApi({ token, repository, fetchImpl = fetch }) {
  if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const get = async (path) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) throw new Error(`GitHub API ${path.split("?")[0]}: HTTP ${res.status}`);
    return res.json();
  };
  return {
    getRuns: async () => (await get(`/actions/workflows/${WORKFLOW}/runs?per_page=${RUNS_LOOKED_AT}`)).workflow_runs ?? [],
    getJobs: async (runId) => (await get(`/actions/runs/${runId}/jobs?per_page=100`)).jobs ?? [],
    getMainSha: async () => (await get(`/commits/main`)).sha,
  };
}

/**
 * Reads the inputs from the environment and the API, then applies the rules. Never throws: an API failure → full.
 * @returns {Promise<{ mode: "full" | "smoke", reason: string }>}
 */
export async function resolveNightlyMode({ env, now = new Date(), api }) {
  const inputs = nightlyInputs({ eventName: env.GITHUB_EVENT_NAME, target: env.TARGET, nightlyMode: env.NIGHTLY_MODE });
  const weekday = istWeekday(now);
  // Decided without the API: not a schedule, another target, or an override.
  const early = decideNightlyMode({ ...inputs, mainSha: "x", lastGreenFullSha: "x", istWeekday: "Mon" });
  if (inputs.event !== "schedule" || inputs.target !== "dev" || inputs.override) {
    return { mode: early, reason: `event ${inputs.event || "none"}, target ${inputs.target}${inputs.override ? `, override ${inputs.override}` : ""}` };
  }
  try {
    const mainSha = env.GITHUB_SHA || (await api.getMainSha?.());
    const lastGreenFullSha = await findLastGreenFullSha(api);
    const mode = decideNightlyMode({ ...inputs, mainSha, lastGreenFullSha, istWeekday: weekday });
    const short = (s) => (s ? String(s).slice(0, 7) : "none");
    return { mode, reason: `main ${short(mainSha)}, last green full run ${short(lastGreenFullSha)}, ${weekday} (IST)` };
  } catch (e) {
    return { mode: "full", reason: `GitHub API failed (${e instanceof Error ? e.message : "unknown error"}) — running full` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let api;
  try {
    api = githubApi({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
  } catch (e) {
    const fail = async () => { throw e; };
    api = { getRuns: fail, getJobs: fail, getMainSha: fail };
  }
  const { mode, reason } = await resolveNightlyMode({ env: process.env, api });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
  const note = `Nightly mode: ${mode} (${reason}).`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`);
  console.log(note);
}
