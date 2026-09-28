export const ROLES = ["admin", "manager", "staff", "limited"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  staff: "Staff",
  limited: "Staff (limited)",
};

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : parts[0][1] ?? "";
  return (first + last).toUpperCase();
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Spec 02 AC-2/AC-3/AC-6: Admin and Manager change the catalogue; everyone else reads it. */
export function canManageCatalogue(role: Role): boolean {
  return role === "admin" || role === "manager";
}

/** Spec 02 AC-5: only Admin adds a financial year (the DB function checks the same). */
export function canAddFinancialYear(role: Role): boolean {
  return role === "admin";
}
