import "server-only";

// Feature 17 (spec AC-1, AC-2). The one reader of TENANCY_MODE (ESLint fence). The mode switches the *shell* only
// (login branding, and later signup/billing/operator console) — never RLS, the data model or business logic, which
// are the same in every deployment.
//   multi  = shared SaaS: many firms in one database, isolated by office_id + RLS (the default when unset)
//   single = one firm per deployment (Dedicated / Customer-owned); the database also refuses a second real office

export type TenancyMode = "multi" | "single";

/** Modules allowed to call tenancyMode() (tests/unit/tenancy.test.ts). Add a module here only with a spec that says why. */
export const TENANCY_MODE_CALLERS: readonly string[] = ["src/lib/auth/login-brand.ts"];

/** Unset or blank → multi (owner, 2026-11-03); multi/single in any case; anything else is a configuration error. */
export function readTenancyMode(raw: string | undefined): TenancyMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "multi") return "multi";
  if (v === "single") return "single";
  throw new Error("TENANCY_MODE must be multi or single");
}

export function tenancyMode(): TenancyMode {
  return readTenancyMode(process.env.TENANCY_MODE);
}
