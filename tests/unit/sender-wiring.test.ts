import { beforeEach, describe, expect, it, vi } from "vitest";

// Feature 17 (spec AC-6; review Important #6): both senders of client email pass the signed-in staff member's firm
// as the From name. The mailer's handling of it is proven in tests/unit/mailer.test.ts; this proves the wiring.

vi.unmock("@/lib/reminders/actions"); // setup-dom stubs it for view tests
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const me = { id: "me", role: "staff", officeId: "o1", officeName: "Firm B & Co", officeBranch: null, fullName: "Priya Raman", email: "priya@firm-b.in" };
vi.mock("@/lib/auth/staff", () => ({ requireStaff: vi.fn(async () => me) }));
const rpc = vi.fn();
const fromClient = { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Client A", archived_at: null }, error: null }) }) }) };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc, from: () => fromClient }) }));
const sendMail = vi.fn(async (..._a: unknown[]) => { void _a; return { status: "sent", providerId: "m1", errorCode: null }; });
vi.mock("@/lib/mail", () => ({ mailConfig: () => ({ dailyMax: 7 }), sendMail: (...a: unknown[]) => sendMail(...a) }));
const message = { subject: "Documents pending — Firm B & Co", text: "Dear A,", html: "<p>Dear A,</p>" };
vi.mock("@/lib/reminders/queries", () => ({
  messageFor: async () => ({ clientName: "Client A", message }), remindDialogAs: vi.fn(), clientRemindersAs: vi.fn(),
  chosenItemsAs: async () => [{ id: "i1" }],
}));
vi.mock("@/lib/expected/queries", () => ({ todayForOffice: async () => "2026-11-03" }));
vi.mock("@/lib/reminders/message", () => ({ buildReminderMessage: () => message }));
vi.mock("@/lib/upload-links/queries", () => ({
  linkBase: () => "https://vault.example.in", adHocLinesAs: async () => [], linkOptionsAs: vi.fn(),
  retryContentAs: async () => ({ clientId: "11111111-1111-4111-8111-111111111111", scheduledIds: ["i1"], adHoc: [] }),
}));

const { sendEmailReminder } = await import("@/lib/reminders/actions");
const { retryLinkEmail } = await import("@/lib/upload-links/actions");

beforeEach(() => { rpc.mockReset(); sendMail.mockClear(); });

describe("the firm's name reaches the mailer (AC-6)", () => {
  it("Remind by email (06)", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "begin_email_reminder" ? { data: { id: "f1", recipient: "a@client.in" }, error: null } : { data: null, error: null });
    await sendEmailReminder("11111111-1111-4111-8111-111111111111", ["22222222-2222-4222-8222-222222222222"]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][2]).toEqual({ fromName: "Firm B & Co" });
  });

  it("an upload-link email (10)", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "retry_link_email"
        ? { data: { follow_up_id: "f2", recipient: "a@client.in", expires_at: "2026-11-20T18:30:00Z" }, error: null }
        : { data: null, error: null });
    await retryLinkEmail("33333333-3333-4333-8333-333333333333");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][2]).toEqual({ fromName: "Firm B & Co" });
  });
});
