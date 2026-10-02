import "server-only";
import { brevoFromEnv } from "./brevo";
import { deliver, readMailConfig, type MailConfig, type MailMessage, type SendResult } from "./core";
import { testTransport } from "./test-transport";

// Feature 06 — the app's single mail entry point (architecture change 1). Server-only.

export type { MailMessage, SendResult } from "./core";

/** Settings from the server environment (read per call so a changed env needs no redeploy of logic). */
export function mailConfig(): MailConfig {
  return readMailConfig({
    MAIL_TRANSPORT: process.env.MAIL_TRANSPORT,
    APP_ENV: process.env.APP_ENV,
    EMAIL_ALLOWLIST: process.env.EMAIL_ALLOWLIST,
    EMAIL_DAILY_MAX: process.env.EMAIL_DAILY_MAX,
    MAIL_FROM_EMAIL: process.env.MAIL_FROM_EMAIL,
    MAIL_FROM_NAME: process.env.MAIL_FROM_NAME,
  });
}

export function sendMail(message: MailMessage, cfg: MailConfig = mailConfig()): Promise<SendResult> {
  return deliver(message, cfg, { test: testTransport, brevo: brevoFromEnv });
}
