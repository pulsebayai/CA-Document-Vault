import type { SendResult, Transport } from "./core";

// Feature 06 — Brevo transactional email over its HTTP API (spec decision 3: a message ID and clear errors, works
// from Vercel functions). The ONLY module allowed to read BREVO_API_KEY (ESLint fence, like SUPABASE_SECRET_KEY).
// No webhook in the pilot: the result is Sent (201) or Failed (anything else, or no answer within 10 s).

export const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
/** Spec NFR: provider timeout 10 s, after which the follow-up is Failed. */
export const BREVO_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

/** The transport for a given key (and fetch, for tests). */
export function createBrevoTransport(apiKey: string, fetchImpl: Fetch = fetch, timeoutMs = BREVO_TIMEOUT_MS): Transport {
  return {
    name: "brevo",
    async send(m): Promise<SendResult> {
      let res: Response;
      try {
        res = await fetchImpl(BREVO_ENDPOINT, {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: { email: m.from.email, ...(m.from.name ? { name: m.from.name } : {}) },
            to: [{ email: m.to }],
            replyTo: { email: m.replyTo.email, ...(m.replyTo.name ? { name: m.replyTo.name } : {}) },
            subject: m.subject,
            textContent: m.text,
            htmlContent: m.html,
            tags: ["reminder"],
          }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        return { status: "failed", providerId: null, errorCode: name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK" };
      }
      if (res.status === 201) {
        const body = (await res.json().catch(() => ({}))) as { messageId?: unknown };
        const id = typeof body.messageId === "string" ? body.messageId.slice(0, 200) : null;
        return { status: "sent", providerId: id, errorCode: null };
      }
      return { status: "failed", providerId: null, errorCode: `BREVO_${res.status}` };
    },
  };
}

/** The app's transport: reads the key here and nowhere else. Throws when unset (deliver() turns it into Failed). */
export function brevoFromEnv(): Transport {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error("BREVO_API_KEY is not set");
  return createBrevoTransport(key);
}
