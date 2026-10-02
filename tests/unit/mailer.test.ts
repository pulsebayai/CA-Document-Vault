import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAILY_MAX, deliver, readMailConfig, recipientAllowed, type MailMessage } from "@/lib/mail/core";
import { testOutbox, testTransport } from "@/lib/mail/test-transport";
import { BREVO_ENDPOINT, createBrevoTransport } from "@/lib/mail/brevo";

// Feature 06 — AC-13 / AC-14 safety rules and the transports. Includes the proof that tests make zero network calls.

const msg = (to: string): MailMessage => ({
  to, subject: "Documents pending — Firm", text: "Dear A,", html: "<p>Dear A,</p>", replyTo: { email: "priya@firm.in", name: "Priya" },
});

afterEach(() => vi.restoreAllMocks());

describe("readMailConfig", () => {
  it("defaults to the test transport, non-production, empty allow-list and a 200/day ceiling", () => {
    expect(readMailConfig({})).toMatchObject({ transport: "test", production: false, from: null, dailyMax: DEFAULT_DAILY_MAX });
    expect(readMailConfig({}).allowlist.size).toBe(0);
  });

  it("reads brevo, production, the allow-list (lower-cased) and the sender", () => {
    const c = readMailConfig({ MAIL_TRANSPORT: "Brevo", APP_ENV: "production", EMAIL_ALLOWLIST: "Raja@Firm.in, a@b.co  junk",
      EMAIL_DAILY_MAX: "50", MAIL_FROM_EMAIL: "vault@firm.in", MAIL_FROM_NAME: "Kushal Associates" });
    expect(c).toMatchObject({ transport: "brevo", production: true, dailyMax: 50, from: { email: "vault@firm.in", name: "Kushal Associates" } });
    expect([...c.allowlist].sort()).toEqual(["a@b.co", "raja@firm.in"]);
  });

  it("rejects an unknown transport instead of guessing", () => {
    expect(() => readMailConfig({ MAIL_TRANSPORT: "ses" })).toThrow(/MAIL_TRANSPORT/);
  });
});

describe("recipientAllowed (AC-13)", () => {
  const dev = readMailConfig({ EMAIL_ALLOWLIST: "raja@firm.in" });
  const prod = readMailConfig({ APP_ENV: "production" });
  it(".test addresses are never sent, in any environment", () => {
    expect(recipientAllowed("client1@example.test", prod)).toBe(false);
    expect(recipientAllowed("client1@example.test", readMailConfig({ EMAIL_ALLOWLIST: "client1@example.test" }))).toBe(false);
  });
  it("outside production only allow-listed addresses go out", () => {
    expect(recipientAllowed("RAJA@firm.in", dev)).toBe(true);
    expect(recipientAllowed("someone@client.in", dev)).toBe(false);
  });
  it("in production any valid address goes out", () => {
    expect(recipientAllowed("someone@client.in", prod)).toBe(true);
    expect(recipientAllowed("not-an-email", prod)).toBe(false);
  });
});

describe("deliver", () => {
  it("with the default (test) transport makes zero network calls, for allowed and suppressed recipients alike", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const brevo = vi.fn();
    const cfg = readMailConfig({ EMAIL_ALLOWLIST: "raja@firm.in" });
    expect(await deliver(msg("raja@firm.in"), cfg, { test: testTransport, brevo })).toEqual({ status: "suppressed", providerId: null, errorCode: null });
    expect(await deliver(msg("x@client.in"), cfg, { test: testTransport, brevo })).toMatchObject({ status: "suppressed" });
    expect(spy).not.toHaveBeenCalled();
    expect(brevo).not.toHaveBeenCalled();
    expect(testOutbox.at(-1)).toMatchObject({ to: "raja@firm.in", replyTo: { email: "priya@firm.in" } });
  });

  it("suppresses before choosing a transport: brevo is never created for a blocked recipient", async () => {
    const brevo = vi.fn();
    const cfg = readMailConfig({ MAIL_TRANSPORT: "brevo", MAIL_FROM_EMAIL: "vault@firm.in" });
    expect(await deliver(msg("x@client.in"), cfg, { test: testTransport, brevo })).toMatchObject({ status: "suppressed" });
    expect(await deliver(msg("y@example.test"), { ...cfg, production: true }, { test: testTransport, brevo })).toMatchObject({ status: "suppressed" });
    expect(brevo).not.toHaveBeenCalled();
  });

  it("brevo without a sender, or with a missing key, fails with a code instead of throwing", async () => {
    const cfg = readMailConfig({ MAIL_TRANSPORT: "brevo", APP_ENV: "production" });
    expect(await deliver(msg("a@client.in"), cfg, { test: testTransport, brevo: () => { throw new Error("no key"); } }))
      .toEqual({ status: "failed", providerId: null, errorCode: "MAIL_FROM_MISSING" });
    const withFrom = { ...cfg, from: { email: "vault@firm.in" } };
    expect(await deliver(msg("a@client.in"), withFrom, { test: testTransport, brevo: () => { throw new Error("no key"); } }))
      .toEqual({ status: "failed", providerId: null, errorCode: "MAIL_CONFIG" });
  });
});

describe("createBrevoTransport", () => {
  const send = (t: ReturnType<typeof createBrevoTransport>) => t.send({ ...msg("a@client.in"), from: { email: "vault@firm.in", name: "Kushal Associates" } });

  it("posts sender, to, replyTo, subject, text and html with the api-key header; 201 → sent with the message ID", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ messageId: "<abc@smtp-relay>" }), { status: 201 }));
    const r = await send(createBrevoTransport("key-123", f as unknown as typeof fetch));
    expect(r).toEqual({ status: "sent", providerId: "<abc@smtp-relay>", errorCode: null });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BREVO_ENDPOINT);
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-123");
    expect(JSON.parse(init.body as string)).toMatchObject({
      sender: { email: "vault@firm.in", name: "Kushal Associates" }, to: [{ email: "a@client.in" }],
      replyTo: { email: "priya@firm.in", name: "Priya" }, subject: "Documents pending — Firm", textContent: "Dear A,", htmlContent: "<p>Dear A,</p>",
    });
  });

  it("any other status → failed BREVO_<status>; a network error → NETWORK; no answer in time → TIMEOUT", async () => {
    expect(await send(createBrevoTransport("k", (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch)))
      .toEqual({ status: "failed", providerId: null, errorCode: "BREVO_401" });
    expect(await send(createBrevoTransport("k", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)))
      .toMatchObject({ status: "failed", errorCode: "NETWORK" });
    const hang = ((_: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    expect(await send(createBrevoTransport("k", hang, 20))).toMatchObject({ status: "failed", errorCode: "TIMEOUT" });
  });
});
