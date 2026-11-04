import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf, mustRpc } from "../support/expected";
import { signedInPlatformAdmin } from "../support/platform";

// Feature 19 — suspend / reactivate a firm (spec AC-7, Y6). Failing-first (plan step 1). Suspension lives in
// private.current_office_id(), so every RLS policy refuses the firm's staff at once; 10's link checks answer NOT_ACTIVE.

type Res = { data: unknown; error: { message: string } | null };
const svc = () => adminClient();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = () => sha(randomBytes(8).toString("hex"));
let F: string;
let staff: { id: string; email: string };
let asStaff: SupabaseClient;
let sa: { id: string; as: SupabaseClient };
let client: string;
let tokenHash: string;
const rpc = (who: SupabaseClient, fn: string, args: Record<string, unknown>) => who.rpc(fn, args) as unknown as Promise<Res>;
const linkWorks = async () => {
  const r = await svc().rpc("link_open", { p_token_hash: tokenHash, p_ip_hash: ip() });
  return !r.error && (r.data as { active?: boolean } | null)?.active === true; // 10: link_open answers { active }
};

beforeAll(async () => {
  F = await createDocumentOffice("platform-suspend");
  await svc().from("office").update({ suspended_at: null, suspended_by: null, suspend_reason: null }).eq("id", F);
  const admin = await createStaff(F, "platform-suspend-admin", "admin");
  staff = await createStaff(F, "platform-suspend-staff", "staff");
  asStaff = await signedInClient(staff.email);
  await generateAsOf(await signedInClient(admin.email), "2026-03-15");
  client = await bankOnlyClient(asStaff, F, { name: "Suspend client", incharge_id: staff.id, mobile: "9876500088" });
  await generateAsOf(await signedInClient(admin.email), "2026-05-15");
  tokenHash = sha(randomBytes(32).toString("base64url"));
  await mustRpc(asStaff, "record_link_whatsapp", { p: { client_id: client, token_hash: tokenHash,
    items: [{ kind: "scheduled", expected_doc_id: (await expectedItem(client, T.bank, "2026-03")).id }] } });
  sa = await signedInPlatformAdmin("platform-sa");
}, 180_000);

afterAll(async () => {
  await svc().from("office").update({ suspended_at: null, suspended_by: null, suspend_reason: null }).eq("id", F);
  await retireStaff([staff?.id].filter(Boolean) as string[]);
});

describe("suspend (AC-7)", () => {
  it("controls: before suspension the staff member works and the link opens", async () => {
    expect((await asStaff.from("client").select("id").eq("id", client)).data).toHaveLength(1);
    expect(await linkWorks()).toBe(true);
  });

  it("needs a reason of 10–500 characters", async () => {
    expect((await rpc(sa.as, "platform_suspend_firm", { p_office: F, p_reason: "late" })).error?.message).toMatch(/REASON_INVALID/);
  });

  it("locks the firm out at once: the signed-in staff member reads and writes nothing, the link is not active", async () => {
    const r = await rpc(sa.as, "platform_suspend_firm", { p_office: F, p_reason: "Unpaid since October (test)" });
    expect(r.error).toBeNull();
    expect((await asStaff.from("client").select("id").eq("id", client)).data ?? []).toEqual([]);
    expect((await asStaff.from("staff_user").select("id").eq("id", staff.id)).data ?? []).toEqual([]);
    const write = await rpc(asStaff, "record_follow_up", { p_client: client, p_items: [], p_channel: "phone", p_on: null, p_note: null });
    expect(write.error).not.toBeNull();
    const link = await svc().rpc("link_open", { p_token_hash: tokenHash, p_ip_hash: ip() });
    expect(link.error).toBeNull();
    expect(link.data).toEqual({ active: false }); // 10's generic answer for any unusable link (= NOT_ACTIVE on /u)
    const act = (await svc().from("activity").select("actor_id, data").eq("office_id", F).eq("action", "office.suspended").order("id", { ascending: false }).limit(1)).data!;
    expect(act[0]).toMatchObject({ actor_id: null });
    expect(JSON.stringify(act)).not.toContain("Unpaid"); // the reason stays on the office row
    const firm = ((await rpc(sa.as, "platform_firms", {})).data as Array<{ id: string; status: string }>).find((f) => f.id === F);
    expect(firm?.status).toBe("suspended");
  });

  it("a second suspend is refused; reactivate restores everything as it was", async () => {
    expect((await rpc(sa.as, "platform_suspend_firm", { p_office: F, p_reason: "Again, should be refused" })).error?.message).toMatch(/ALREADY_SUSPENDED/);
    expect((await rpc(sa.as, "platform_reactivate_firm", { p_office: F })).error).toBeNull();
    expect((await asStaff.from("client").select("id").eq("id", client)).data).toHaveLength(1);
    expect(await linkWorks()).toBe(true);
    expect((await svc().from("activity").select("id").eq("office_id", F).eq("action", "office.reactivated")).data?.length).toBeGreaterThan(0);
    expect((await rpc(sa.as, "platform_reactivate_firm", { p_office: F })).error?.message).toMatch(/NOT_SUSPENDED/);
    // AC-12: the audit log keeps the suspension's reason after the firm is reactivated (the office row no longer has it)
    const log = (await rpc(sa.as, "platform_audit_list", { p: { office_id: F, action: "firm.suspended" } })).data as { rows: Array<{ reason: string | null }> };
    expect(log.rows[0]?.reason).toBe("Unpaid since October (test)");
  });

  it("the nightly job skips a suspended firm, and a one-firm (single) deployment refuses suspend and create (rolled-back probe, D3; review I-2)", async (ctx) => {
    // run_daily_expected covers real offices only, so the probe suspends one inside a block that is always rolled back.
    // The probe is refused where a deployment mode is set (staging, prod), like 17's: skipped there by design (review I-1).
    const r = await svc().rpc("test_platform_probe");
    if (r.error?.message.startsWith("NOT_TEST_DEPLOYMENT")) return ctx.skip();
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ suspended_rows: 0, control_rows: 1, single_suspend: "SINGLE_MODE", single_create: "SINGLE_MODE" });
    // refused for staff
    expect((await asStaff.rpc("test_platform_probe")).error).not.toBeNull();
  }, 120_000);
});
