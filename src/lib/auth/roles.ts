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
