import { ACTIVITY_CATALOGUE } from "./catalogue";

// Feature 08 AC-7 — the Action filter. Each catalogue entry names its category; the server turns a category into
// the exact action list for activity_feed. Sign-ins are their own category and hidden otherwise (AC-8).

export const ACTIVITY_CATEGORIES = [
  { id: "documents", label: "Documents" },
  { id: "review_dispatch", label: "Review & dispatch" },
  { id: "expected", label: "Expected" },
  { id: "reminders", label: "Reminders" },
  { id: "clients_plans", label: "Clients & plans" },
  { id: "catalogue", label: "Catalogue" },
  { id: "users", label: "Users" },
  { id: "sign_ins", label: "Sign-ins" },
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]["id"];

export const isActivityCategory = (v: unknown): v is ActivityCategory =>
  typeof v === "string" && ACTIVITY_CATEGORIES.some((c) => c.id === v);

/** The actions in one category, sorted. */
export function actionsFor(category: ActivityCategory): string[] {
  return Object.entries(ACTIVITY_CATALOGUE).filter(([, e]) => e.category === category).map(([a]) => a).sort();
}
