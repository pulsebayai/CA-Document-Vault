// Feature 06 — the mailer (spec "Functional requirements: Mailer interface", AC-13, AC-14; architecture change 1).
// Pure and dependency-injected so the rules are unit-tested without a network: the app wires real transports in
// ./index.ts (server-only). Nothing here reads secrets; only ./brevo.ts may read BREVO_API_KEY (ESLint fence).
//
// Safety rules, applied inside deliver() BEFORE any transport is chosen:
//   1. an address ending ".test" is never sent, in any environment (fixture users and clients);
//   2. outside production (APP_ENV ≠ "production"), only addresses on EMAIL_ALLOWLIST are sent;
//   3. MAIL_TRANSPORT unset → "test", which never makes a network call. Production/staging set "brevo" on purpose.

export type MailAddress = { email: string; name?: string };

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** AC-8 / spec decision 1: the staff member who presses Send. */
  replyTo: MailAddress;
};

export type SendStatus = "sent" | "failed" | "suppressed";
/** errorCode matches follow_up.error_code: ^[A-Z0-9_]{1,64}$. providerId is Brevo's message ID. */
export type SendResult = { status: SendStatus; providerId: string | null; errorCode: string | null };

export type Transport = {
  name: "brevo" | "test";
  send(message: MailMessage & { from: MailAddress }): Promise<SendResult>;
};

export type MailConfig = {
  transport: "brevo" | "test";
  production: boolean;
  allowlist: ReadonlySet<string>;
  from: MailAddress | null;
  /** AC-14: office emails per day (sent + in flight). Passed to begin_email_reminder. */
  dailyMax: number;
};

export type MailEnv = Partial<Record<
  "MAIL_TRANSPORT" | "APP_ENV" | "EMAIL_ALLOWLIST" | "EMAIL_DAILY_MAX" | "MAIL_FROM_EMAIL" | "MAIL_FROM_NAME", string
>>;

export const DEFAULT_DAILY_MAX = 200;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Reads the mail settings. Unset transport → "test"; an unknown value is a configuration error, not a guess. */
export function readMailConfig(e: MailEnv): MailConfig {
  const raw = (e.MAIL_TRANSPORT ?? "").trim().toLowerCase();
  if (raw !== "" && raw !== "brevo" && raw !== "test") throw new Error("MAIL_TRANSPORT must be brevo or test");
  const allowlist = new Set(
    (e.EMAIL_ALLOWLIST ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)),
  );
  const max = Number.parseInt(e.EMAIL_DAILY_MAX ?? "", 10);
  const fromEmail = (e.MAIL_FROM_EMAIL ?? "").trim().toLowerCase();
  return {
    transport: raw === "brevo" ? "brevo" : "test",
    production: (e.APP_ENV ?? "").trim().toLowerCase() === "production",
    allowlist,
    from: EMAIL.test(fromEmail) ? { email: fromEmail, name: (e.MAIL_FROM_NAME ?? "").trim() || undefined } : null,
    dailyMax: Number.isFinite(max) && max >= 0 ? max : DEFAULT_DAILY_MAX,
  };
}

/** AC-13. True only if the address may actually leave the vault in this environment. */
export function recipientAllowed(to: string, cfg: Pick<MailConfig, "production" | "allowlist">): boolean {
  const addr = to.trim().toLowerCase();
  if (!EMAIL.test(addr)) return false;
  if (addr.endsWith(".test")) return false;
  return cfg.production || cfg.allowlist.has(addr);
}

const suppressed: SendResult = { status: "suppressed", providerId: null, errorCode: null };

/**
 * Sends one message through the configured transport, after the safety rules. Never throws: a transport error is
 * a "failed" result with a code (the follow-up shows Failed + Retry). `transports.brevo` is created lazily so the
 * Brevo key is never read when the transport is "test".
 */
export async function deliver(
  message: MailMessage, cfg: MailConfig, transports: { test: Transport; brevo: () => Transport },
): Promise<SendResult> {
  if (!recipientAllowed(message.to, cfg)) return suppressed;
  if (cfg.transport === "test") return transports.test.send({ ...message, from: cfg.from ?? { email: "vault@example.test" } });
  if (!cfg.from) return { status: "failed", providerId: null, errorCode: "MAIL_FROM_MISSING" };
  try {
    return await transports.brevo().send({ ...message, from: cfg.from });
  } catch {
    return { status: "failed", providerId: null, errorCode: "MAIL_CONFIG" };
  }
}
