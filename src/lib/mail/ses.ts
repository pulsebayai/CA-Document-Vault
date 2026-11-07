import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { MailAddress, SendResult, Transport } from "./core";

// chore ses-mailer (2026-11-06, architecture decision log: SES for staging and prod) — AWS SES v2 in Mumbai.
// The ONLY module allowed to read SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY / SES_REGION (ESLint fence, like
// BREVO_API_KEY). Credentials are passed explicitly, so the SDK never falls back to another credential source.
// Same contract as ./brevo.ts: Sent (SES returned a MessageId) or Failed with a code; no answer in 10 s = TIMEOUT.
// Names are not secret: SES_* rather than AWS_* because Vercel reserves the AWS_* names for its own runtime.

/** Spec NFR (06): provider timeout 10 s, after which the follow-up is Failed. */
export const SES_TIMEOUT_MS = 10_000;
/** India-resident sending (decision log 2026-11-06): any other region needs a decision, not a typo. */
export const SES_REGION = "ap-south-1";

/** The part of the SES client this transport uses (a fake in unit tests). */
export type SesSend = (command: SendEmailCommand, opts: { abortSignal: AbortSignal }) => Promise<{ MessageId?: string }>;

/** An address header value. Non-ASCII display names are RFC 2047 encoded-words (SES refuses raw UTF-8 there). */
export function formatAddress(a: MailAddress): string {
  const name = (a.name ?? "").replace(/[\p{Cc}\p{Cf}"<>\\]/gu, " ").replace(/\s+/g, " ").trim();
  if (!name) return a.email;
  const label = /^[\x20-\x7e]*$/.test(name) ? `"${name}"` : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
  return `${label} <${a.email}>`;
}

/** follow_up.error_code is ^[A-Z0-9_]{1,64}$. */
function code(prefix: string, raw: unknown): string {
  const tail = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (tail ? `${prefix}_${tail}` : prefix).slice(0, 64);
}

/** The transport for a given SES send function (and timeout, for tests). */
export function createSesTransport(send: SesSend, timeoutMs = SES_TIMEOUT_MS): Transport {
  return {
    name: "ses",
    async send(m): Promise<SendResult> {
      const command = new SendEmailCommand({
        FromEmailAddress: formatAddress(m.from),
        Destination: { ToAddresses: [m.to] },
        ReplyToAddresses: [formatAddress(m.replyTo)],
        Content: {
          Simple: {
            Subject: { Data: m.subject, Charset: "UTF-8" },
            Body: { Text: { Data: m.text, Charset: "UTF-8" }, Html: { Data: m.html, Charset: "UTF-8" } },
          },
        },
        EmailTags: [{ Name: "kind", Value: "reminder" }],
      });
      try {
        const out = await send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });
        const id = typeof out.MessageId === "string" && out.MessageId !== "" ? out.MessageId.slice(0, 200) : null;
        return id ? { status: "sent", providerId: id, errorCode: null } : { status: "failed", providerId: null, errorCode: "SES_NO_MESSAGE_ID" };
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err?.name === "TimeoutError" || err?.name === "AbortError") return { status: "failed", providerId: null, errorCode: "TIMEOUT" };
        // An answer from SES (MessageRejected, AccountSuspended, MailFromDomainNotVerified …) vs no answer at all.
        if (err?.$metadata?.httpStatusCode) return { status: "failed", providerId: null, errorCode: code("SES", err.name) };
        return { status: "failed", providerId: null, errorCode: "NETWORK" };
      }
    },
  };
}

/** The app's transport: reads the credentials here and nowhere else. Throws when unset (deliver() turns it into Failed). */
export function sesFromEnv(): Transport {
  const accessKeyId = process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY are not set");
  const region = (process.env.SES_REGION ?? "").trim() || SES_REGION;
  if (region !== SES_REGION) throw new Error(`SES_REGION must be ${SES_REGION}`);
  const client = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
  return createSesTransport((command, opts) => client.send(command, opts));
}
