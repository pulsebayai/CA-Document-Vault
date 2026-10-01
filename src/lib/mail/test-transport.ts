import type { MailAddress, MailMessage, SendResult, Transport } from "./core";

// Feature 06 — the "test" transport (default when MAIL_TRANSPORT is unset): CI, local runs and previews.
// Never touches the network. Keeps the last messages in memory (per server instance) so unit tests can inspect
// them; the result is always "suppressed" (spec: records nothing externally).

export type OutboxEntry = MailMessage & { from: MailAddress; at: string };
const MAX_KEPT = 20;
export const testOutbox: OutboxEntry[] = [];

export const testTransport: Transport = {
  name: "test",
  async send(message): Promise<SendResult> {
    testOutbox.push({ ...message, at: new Date().toISOString() });
    if (testOutbox.length > MAX_KEPT) testOutbox.splice(0, testOutbox.length - MAX_KEPT);
    return { status: "suppressed", providerId: null, errorCode: null };
  },
};
