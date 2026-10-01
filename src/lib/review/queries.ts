import "server-only";
import { createClient } from "@/lib/supabase/server";

// Feature 07 AC-7: the review history on the document page, newest first. Runs as the user (RLS: the history
// follows the document's visibility).

export type ReviewEvent = {
  id: string;
  outcome: "reviewed" | "needs_correction" | "undone" | "reset";
  reason: string | null;
  actor: string;
  at: string;
};

export async function reviewHistoryFor(documentId: string): Promise<ReviewEvent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("document_review")
    .select("id, outcome, reason, created_at, actor:actor_id (full_name)")
    .eq("document_id", documentId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
  if (error) throw new Error("Could not load the review history.");
  return ((data ?? []) as unknown as Array<{ id: string; outcome: ReviewEvent["outcome"]; reason: string | null; created_at: string; actor: { full_name: string } | null }>)
    .map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason, actor: r.actor?.full_name ?? "System", at: r.created_at }));
}
