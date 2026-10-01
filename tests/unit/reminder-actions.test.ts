import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature 06 step 4 — the server actions' contract (AC-8, AC-9, AC-11) with the database, mailer and queries mocked.
// The database rules themselves (cap, ceiling, items, visibility) are proven in tests/rls/follow-up.test.ts.

vi.unmock("@/lib/reminders/actions"); // tests the real actions (setup-dom stubs them for view tests)
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const me = { id: "me", role: "staff", officeId: "o1", officeName: "Kushal Associates", fullName: "Priya Raman", email: "priya@firm.in" };
vi.mock("@/lib/auth/staff", () => ({ requireStaff: vi.fn(async () => me) }));
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
const sendMail = vi.fn();
vi.mock("@/lib/mail", () => ({ mailConfig: () => ({ dailyMax: 7 }), sendMail: (...a: unknown[]) => sendMail(...a) }));
const messageFor = vi.fn();
vi.mock("@/lib/reminders/queries", () => ({
  messageFor: (...a: unknown[]) => messageFor(...a), remindDialogAs: vi.fn(), clientRemindersAs: vi.fn(),
}));

const { sendEmailReminder, recordWhatsApp, logCall } = await import("@/lib/reminders/actions");

const C = "11111111-1111-4111-8111-111111111111";
const I1 = "22222222-2222-4222-8222-222222222222";
const message = { subject: "Documents pending — Kushal Associates", text: "Dear A,", html: "<p>Dear A,</p>" };

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  rpc.mockReset(); sendMail.mockReset(); messageFor.mockReset();
  messageFor.mockResolvedValue({ clientName: "A", message });
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

describe("sendEmailReminder (AC-8: two-phase)", () => {
  it("builds the message, begins (cap + ceiling in the DB), sends with Reply-To = the sender, then finishes", async () => {
    const order: string[] = [];
    rpc.mockImplementation(async (fn: string) => {
      order.push(fn);
      return fn === "begin_email_reminder" ? { data: { id: "f1", recipient: "abc@client.in" }, error: null } : { data: null, error: null };
    });
    sendMail.mockImplementation(async () => { order.push("send"); return { status: "sent", providerId: "m1", errorCode: null }; });
    const r = await sendEmailReminder(C, [I1]);
    expect(order).toEqual(["begin_email_reminder", "send", "finish_email_reminder"]);
    expect(rpc.mock.calls[0][1]).toEqual({ p_client: C, p_items: [I1], p_daily_max: 7 });
    expect(sendMail.mock.calls[0][0]).toEqual({ to: "abc@client.in", ...message, replyTo: { email: "priya@firm.in", name: "Priya Raman" } });
    expect(rpc.mock.calls[1][1]).toEqual({ p_id: "f1", p_status: "sent", p_provider_id: "m1", p_error_code: null });
    expect(r).toMatchObject({ ok: true, status: "sent", to: "a…@…" });
  });

  it("a refusal from the database (already emailed today) sends nothing", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "ALREADY_EMAILED_TODAY: one email per client per day" } });
    expect(await sendEmailReminder(C, [I1])).toEqual({ ok: false, error: "This client was already emailed today. One email per client per day." });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("a provider failure is recorded as failed and offered for retry", async () => {
    rpc.mockImplementation(async (fn: string) => fn === "begin_email_reminder"
      ? { data: { id: "f1", recipient: "abc@client.in" }, error: null } : { data: null, error: null });
    sendMail.mockResolvedValue({ status: "failed", providerId: null, errorCode: "TIMEOUT" });
    const r = await sendEmailReminder(C, [I1]);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_status: "failed", p_error_code: "TIMEOUT" });
    expect(r).toMatchObject({ ok: true, status: "failed", error: expect.stringContaining("retry") });
  });

  it("items that closed meanwhile never reach begin; invalid input never reaches the database", async () => {
    messageFor.mockResolvedValue(null);
    expect(await sendEmailReminder(C, [I1])).toMatchObject({ ok: false });
    expect(await sendEmailReminder("not-a-uuid", [I1])).toMatchObject({ ok: false });
    expect(await sendEmailReminder(C, [])).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("logs a code and request ID only — never the address or text", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom abc@client.in" } });
    const r = await sendEmailReminder(C, [I1]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Ref [0-9a-f]{8}/) });
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/@|Dear/);
  });
});

describe("recordWhatsApp and logCall (AC-9, AC-11)", () => {
  it("records WhatsApp as a follow-up", async () => {
    rpc.mockResolvedValue({ data: "f2", error: null });
    expect(await recordWhatsApp(C, [I1])).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("record_follow_up", { p_client: C, p_items: [I1], p_channel: "whatsapp" });
  });

  it("logs a call with its date and trimmed note; refuses a long note before the database", async () => {
    rpc.mockResolvedValue({ data: "f3", error: null });
    expect(await logCall({ clientId: C, itemIds: [I1], on: "2026-09-30", note: "  Will send Friday " })).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("record_follow_up", { p_client: C, p_items: [I1], p_channel: "phone", p_on: "2026-09-30", p_note: "Will send Friday" });
    rpc.mockClear();
    expect(await logCall({ clientId: C, itemIds: [I1], note: "x".repeat(301) })).toEqual({ ok: false, error: "Keep the note to 300 characters." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps the database's FUTURE_DATE refusal to plain text", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "FUTURE_DATE: a call cannot be logged for a future date" } });
    expect(await logCall({ clientId: C, itemIds: [I1], on: "2099-01-01" })).toEqual({ ok: false, error: "A call can't be logged for a future date." });
  });
});
