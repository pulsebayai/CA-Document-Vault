import { describe, expect, it } from "vitest";
import { DEV_PROJECT_REF, preflight } from "../../scripts/dev-preflight.mjs";

// Chore test-volume step 2: the nightly dev smoke first proves that dev's service-role key still works and the
// database answers (expired key, paused DB), with one read and no writes. No network here: the client is faked.
const KEY = "sb_secret_THIS-IS-A-FAKE-KEY-0123456789";
const DEV_URL = `https://${DEV_PROJECT_REF}.supabase.co`;
const env = { NEXT_PUBLIC_SUPABASE_URL: DEV_URL, SUPABASE_SECRET_KEY: KEY };

type Result = { data: unknown; error: { message: string; code?: string } | null };

/** A fake supabase client that records every call and answers the one read with `result` (or throws `throws`). */
function fakeClient(result: Result | (() => never)) {
  const calls: string[] = [];
  const made: { url?: string; key?: string } = {};
  const makeClient = (url: string, key: string) => {
    made.url = url;
    made.key = key;
    const query = {
      select(cols: string) { calls.push(`select:${cols}`); return query; },
      limit(n: number) {
        calls.push(`limit:${n}`);
        return typeof result === "function" ? Promise.reject(new Error("fetch failed")) : Promise.resolve(result);
      },
      insert() { calls.push("insert"); return query; },
      update() { calls.push("update"); return query; },
      delete() { calls.push("delete"); return query; },
      upsert() { calls.push("upsert"); return query; },
    };
    return {
      from(table: string) { calls.push(`from:${table}`); return query; },
      rpc(name: string) { calls.push(`rpc:${name}`); return Promise.resolve({ data: null, error: null }); },
    };
  };
  return { makeClient, calls, made };
}

describe("dev preflight", () => {
  it("a working key and database → ok, after exactly one read of test_lane", async () => {
    const f = fakeClient({ data: [{ lane: 1 }], error: null });
    const r = await preflight({ env, makeClient: f.makeClient });
    expect(r.ok).toBe(true);
    expect(f.made).toEqual({ url: DEV_URL, key: KEY });
    expect(f.calls).toEqual(["from:test_lane", "select:lane", "limit:1"]);
  });

  it("missing settings → not ok, naming the variables only", async () => {
    const f = fakeClient({ data: [{ lane: 1 }], error: null });
    const r = await preflight({ env: { NEXT_PUBLIC_SUPABASE_URL: DEV_URL }, makeClient: f.makeClient });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/SUPABASE_SECRET_KEY/);
    expect(f.calls).toEqual([]);
    const r2 = await preflight({ env: { SUPABASE_SECRET_KEY: KEY }, makeClient: f.makeClient });
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(r2.message).not.toContain(KEY);
  });

  it("a URL that isn't the dev project → not ok, and nothing is called (never staging or prod)", async () => {
    for (const url of ["https://uszjymzaggyobxwycrde.supabase.co", "https://example.com", "not a url", `http://${DEV_PROJECT_REF}.supabase.co`]) {
      const f = fakeClient({ data: [{ lane: 1 }], error: null });
      const r = await preflight({ env: { ...env, NEXT_PUBLIC_SUPABASE_URL: url }, makeClient: f.makeClient });
      expect(r.ok, url).toBe(false);
      expect(r.message, url).toMatch(/dev/i);
      expect(f.calls, url).toEqual([]);
      expect(f.made.key, url).toBeUndefined();
    }
  });

  it("an expired or invalid key → not ok with a short reason, never the key", async () => {
    const f = fakeClient({ data: null, error: { message: `Invalid API key ${KEY}`, code: "401" } });
    const r = await preflight({ env, makeClient: f.makeClient });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Invalid API key/);
    expect(r.message).not.toContain(KEY);
  });

  it("an unreachable or paused database (the request throws) → not ok, never the key", async () => {
    const f = fakeClient(() => { throw new Error("unreachable"); });
    const r = await preflight({ env, makeClient: f.makeClient });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/fetch failed/);
    expect(r.message).not.toContain(KEY);
  });

  it("an answer with no rows → not ok (the service role sees every lane, so the key isn't the service role)", async () => {
    const f = fakeClient({ data: [], error: null });
    const r = await preflight({ env, makeClient: f.makeClient });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no rows/i);
  });

  it("a client factory that throws → not ok, never throws itself", async () => {
    const r = await preflight({ env, makeClient: () => { throw new Error(`bad key ${KEY}`); } });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(KEY);
  });
});
