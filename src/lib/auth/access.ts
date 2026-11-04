// Feature 19 (spec AC-3, AC-7): who the signed-in user is, and where each kind of user belongs. One table, used by
// sign-in (finish.ts → actions.ts) and by requireStaff's refusal path, so the two can't disagree.
//   staff     — active (or invited) staff of a firm that isn't suspended → the firm's app
//   platform  — an active super admin (never staff anywhere)             → /platform
//   suspended — staff of a suspended firm                                  → signed out, "paused" notice
//   none      — deactivated staff or super admin, or nobody we know       → signed out, "removed" notice
export type AccessState = "staff" | "platform" | "suspended" | "none";

export const ACCESS_STATES: readonly AccessState[] = ["staff", "platform", "suspended", "none"];

/** Where a request goes when it needs a firm's staff member but the user is something else (requireStaff). */
export const AWAY_FROM_STAFF_PAGES: Record<Exclude<AccessState, "staff">, string> = {
  platform: "/platform",
  suspended: "/auth/paused", // a route handler: clears the session, then /login?reason=paused
  none: "/auth/removed",
};

/** Where a successful sign-in lands (link and invite sign-ins; the code form shows the notices inline). */
export const AFTER_SIGN_IN: Record<AccessState, string> = {
  staff: "/today", // 06 AC-1
  platform: "/platform",
  suspended: "/login?reason=paused",
  none: "/login?reason=removed",
};

export const PAUSED_MESSAGE = "This firm's access is paused. Contact your firm's administrator.";
export const REMOVED_MESSAGE = "Your access has been removed. Contact your administrator.";

export const isAccessState = (v: unknown): v is AccessState => ACCESS_STATES.includes(v as AccessState);
