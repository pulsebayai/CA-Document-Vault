import { afterEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { deliver, readMailConfig, type MailMessage } from "@/lib/mail/core";
import { testOutbox, testTransport } from "@/lib/mail/test-transport";
import { createSesTransport, formatAddress, sesFromEnv, SES_REGION, type SesSend } from "@/lib/mail/ses";

// chore ses-mailer (decision log 2026-11-06): the SES sender keeps 06's contract — Sent with SES's MessageId, or
// Failed with a follow_up.error_code — and 06/17's safety rules run before it, unchanged.

const msg = (to = "client@firm.in"): MailMessage => ({
  to, subject: "Documents pending — Firm", text: "Dear A,", html: "<p>Dear A,</p>", replyTo: { email: "priya@firm.in", name: "Priya" },
});
const from = { email: "vault@pulsebay.in", name: "Kushal Associates" };

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); testOutbox.length = 0; });

describe("readMailConfig", () => {
  it("accepts ses (any case), as staging and prod set it", () => {
    expect(readMailConfig({ MAIL_TRANSPORT: " SES " }).transport).toBe("ses");
  });
});

describe("formatAddress", () => {
  it("quotes an ASCII name, encodes a non-ASCII one, and drops quotes, brackets and control characters", () => {
    expect(formatAddress({ email: "a@b.in" })).toBe("a@b.in");
    expect(formatAddress({ email: "a@b.in", name: "Kushal Associates" })).toBe('"Kushal Associates" <a@b.in>');
    expect(formatAddress({ email: "a@b.in", name: 'Evil" <x@y.z>\r\nBcc: z' })).toBe('"Evil x@y.z Bcc: z" <a@b.in>');
    expect(formatAddress({ email: "a@b.in", name: "शर्मा & Co" })).toBe(`=?UTF-8?B?${Buffer.from("शर्मा & Co").toString("base64")}?= <a@b.in>`);
  });
});

describe("createSesTransport", () => {
  it("sends one SendEmail with From = firm name on the platform address, Reply-To = the staff member, both bodies", async () => {
    const send = vi.fn<SesSend>(async () => ({ MessageId: "0109019a-abc" }));
    const r = await createSesTransport(send).send({ ...msg(), from });
    expect(r).toEqual({ status: "sent", providerId: "0109019a-abc", errorCode: null });
    expect(send).toHaveBeenCalledTimes(1);
    const [cmd, opts] = send.mock.calls[0];
    expect(cmd).toBeInstanceOf(SendEmailCommand);
    expect(cmd.input).toMatchObject({
      FromEmailAddress: '"Kushal Associates" <vault@pulsebay.in>',
      Destination: { ToAddresses: ["client@firm.in"] },
      ReplyToAddresses: ['"Priya" <priya@firm.in>'],
      Content: { Simple: { Subject: { Data: "Documents pending — Firm", Charset: "UTF-8" },
        Body: { Text: { Data: "Dear A,", Charset: "UTF-8" }, Html: { Data: "<p>Dear A,</p>", Charset: "UTF-8" } } } },
    });
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("maps every failure to a follow_up.error_code (^[A-Z0-9_]{1,64}$)", async () => {
    const fail = (e: unknown) => createSesTransport(async () => { throw e; }).send({ ...msg(), from });
    const sesErr = (name: string) => Object.assign(new Error("x"), { name, $metadata: { httpStatusCode: 400 } });
    expect(await fail(sesErr("MessageRejected"))).toEqual({ status: "failed", providerId: null, errorCode: "SES_MESSAGEREJECTED" });
    expect(await fail(sesErr("MailFromDomainNotVerifiedException"))).toMatchObject({ errorCode: "SES_MAILFROMDOMAINNOTVERIFIEDEXCEPTION" });
    expect(await fail(Object.assign(new Error("t"), { name: "TimeoutError" }))).toMatchObject({ errorCode: "TIMEOUT" });
    expect(await fail(Object.assign(new Error("a"), { name: "AbortError" }))).toMatchObject({ errorCode: "TIMEOUT" });
    expect(await fail(new Error("getaddrinfo ENOTFOUND"))).toMatchObject({ errorCode: "NETWORK" });
    const long = await fail(sesErr("X".repeat(200)));
    expect(long.errorCode).toMatch(/^[A-Z0-9_]{1,64}$/);
    expect(await createSesTransport(async () => ({})).send({ ...msg(), from })).toMatchObject({ status: "failed", errorCode: "SES_NO_MESSAGE_ID" });
  });

  it("gives up after its time limit (the follow-up shows Failed + Retry)", async () => {
    const hang: SesSend = (_c, { abortSignal }) => new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason)));
    expect(await createSesTransport(hang, 20).send({ ...msg(), from })).toMatchObject({ status: "failed", errorCode: "TIMEOUT" });
  });
});

describe("deliver with ses", () => {
  const cfg = (extra: Record<string, string> = {}) =>
    readMailConfig({ MAIL_TRANSPORT: "ses", APP_ENV: "production", MAIL_FROM_EMAIL: "vault@pulsebay.in", MAIL_FROM_NAME: "CA Document Vault", ...extra });

  it("uses the ses transport, with the firm's name as the From name (17)", async () => {
    const send = vi.fn<SesSend>(async () => ({ MessageId: "m1" }));
    const brevo = vi.fn(() => { throw new Error("brevo must not be built"); });
    const r = await deliver(msg(), cfg(), { test: testTransport, brevo, ses: () => createSesTransport(send) }, { fromName: "Sharma & Co" });
    expect(r.status).toBe("sent");
    expect(brevo).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].input.FromEmailAddress).toBe('"Sharma & Co" <vault@pulsebay.in>');
  });

  it("the safety rules run before SES: .test never, the allow-list outside production, no From → Failed", async () => {
    const make = vi.fn(() => createSesTransport(async () => ({ MessageId: "m" })));
    const t = { test: testTransport, brevo: () => { throw new Error("no"); }, ses: make };
    expect(await deliver(msg("x@example.test"), cfg(), t)).toMatchObject({ status: "suppressed" });
    expect(await deliver(msg(), cfg({ APP_ENV: "staging", EMAIL_ALLOWLIST: "tester@firm.in" }), t)).toMatchObject({ status: "suppressed" });
    expect(await deliver(msg(), readMailConfig({ MAIL_TRANSPORT: "ses", APP_ENV: "production" }), t)).toMatchObject({ status: "failed", errorCode: "MAIL_FROM_MISSING" });
    expect(make).not.toHaveBeenCalled();
  });

  it("missing credentials or a region other than Mumbai is MAIL_CONFIG, never a send", async () => {
    const t = { test: testTransport, brevo: () => { throw new Error("no"); }, ses: sesFromEnv };
    vi.stubEnv("SES_ACCESS_KEY_ID", ""); vi.stubEnv("SES_SECRET_ACCESS_KEY", "");
    expect(await deliver(msg(), cfg(), t)).toMatchObject({ status: "failed", errorCode: "MAIL_CONFIG" });
    vi.stubEnv("SES_ACCESS_KEY_ID", "AKIAEXAMPLE"); vi.stubEnv("SES_SECRET_ACCESS_KEY", "secret"); vi.stubEnv("SES_REGION", "us-east-1");
    expect(await deliver(msg(), cfg(), t)).toMatchObject({ status: "failed", errorCode: "MAIL_CONFIG" });
    expect(SES_REGION).toBe("ap-south-1");
  });

  it("a caller that doesn't offer ses gets MAIL_CONFIG, not Brevo", async () => {
    const brevo = vi.fn(() => { throw new Error("brevo must not be built"); });
    expect(await deliver(msg(), cfg(), { test: testTransport, brevo })).toMatchObject({ status: "failed", errorCode: "MAIL_CONFIG" });
    expect(brevo).not.toHaveBeenCalled();
  });
});
