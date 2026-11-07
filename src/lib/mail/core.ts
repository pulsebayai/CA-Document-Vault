// Feature 06 — the mailer (spec "Functional requirements: Mailer interface", AC-13, AC-14; architecture change 1).
// Pure and dependency-injected so the rules are unit-tested without a network: the app wires real transports in
// ./index.ts (server-only). Nothing here reads secrets; only ./brevo.ts may read BREVO_API_KEY and only ./ses.ts the
// SES_* credentials (ESLint fences).
//
// Safety rules, applied inside deliver() BEFORE any transport is chosen:
//   1. an address ending ".test" is never sent, in any environment (fixture users and clients);
//   2. outside production (APP_ENV ≠ "production"), only addresses on EMAIL_ALLOWLIST are sent;
//   3. MAIL_TRANSPORT unset → "test", which never makes a network call. Staging/prod set "ses" on purpose
//      (chore ses-mailer, 2026-11-06); dev may set "brevo".

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
/** errorCode matches follow_up.error_code: ^[A-Z0-9_]{1,64}$. providerId is the provider's message ID (Brevo or SES). */
export type SendResult = { status: SendStatus; providerId: string | null; errorCode: string | null };

export type TransportName = "brevo" | "ses" | "test";

export type Transport = {
  name: TransportName;
  send(message: MailMessage & { from: MailAddress }): Promise<SendResult>;
};

export type MailConfig = {
  transport: TransportName;
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
  if (raw !== "" && raw !== "brevo" && raw !== "ses" && raw !== "test") throw new Error("MAIL_TRANSPORT must be brevo, ses or test");
  const allowlist = new Set(
    (e.EMAIL_ALLOWLIST ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)),
  );
  const max = Number.parseInt(e.EMAIL_DAILY_MAX ?? "", 10);
  const fromEmail = (e.MAIL_FROM_EMAIL ?? "").trim().toLowerCase();
  return {
    transport: raw === "brevo" || raw === "ses" ? raw : "test",
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

/** 17 (S1): who the message is sent for. Kept apart from MailMessage so callers' messages are unchanged. */
export type SendOptions = { fromName?: string };

/** 17 (AC-7): a firm name safe for a From header — no control/format characters, quotes or angle brackets; ≤ 70 characters. */
export function senderName(raw: string | undefined): string | undefined {
  // Control and format characters (CR/LF, NUL, bidi marks…) and quote/angle brackets become spaces; cut by character,
  // not UTF-16 unit, so a 70-character cut never splits an emoji or other surrogate pair.
  const v = Array.from((raw ?? "").replace(/[\p{Cc}\p{Cf}"<>]/gu, " ").replace(/\s+/g, " ").trim()).slice(0, 70).join("").trim();
  return v === "" ? undefined : v;
}

/** The From address: the platform's (MAIL_FROM_EMAIL) with the sending firm's name when given (17, S1). */
function fromFor(base: MailAddress, opts: SendOptions): MailAddress {
  const name = senderName(opts.fromName) ?? base.name;
  return name ? { email: base.email, name } : { email: base.email };
}

const suppressed: SendResult = { status: "suppressed", providerId: null, errorCode: null };

/**
 * Sends one message through the configured transport, after the safety rules. Never throws: a transport error is
 * a "failed" result with a code (the follow-up shows Failed + Retry). `transports.brevo` / `transports.ses` are created
 * lazily, so a provider's credentials are read only when that provider is the configured one.
 */
export async function deliver(
  message: MailMessage, cfg: MailConfig, transports: { test: Transport; brevo: () => Transport; ses?: () => Transport }, opts: SendOptions = {},
): Promise<SendResult> {
  if (!recipientAllowed(message.to, cfg)) return suppressed;
  if (cfg.transport === "test") return transports.test.send({ ...message, from: fromFor(cfg.from ?? { email: "vault@example.test" }, opts) });
  if (!cfg.from) return { status: "failed", providerId: null, errorCode: "MAIL_FROM_MISSING" };
  try {
    const make = cfg.transport === "ses" ? transports.ses : transports.brevo;
    if (!make) return { status: "failed", providerId: null, errorCode: "MAIL_CONFIG" };
    return await make().send({ ...message, from: fromFor(cfg.from, opts) });
  } catch {
    return { status: "failed", providerId: null, errorCode: "MAIL_CONFIG" };
  }
}
