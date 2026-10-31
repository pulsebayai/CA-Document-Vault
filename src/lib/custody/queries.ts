import { createClient } from "@/lib/supabase/server";

/** 13 (spec AC-18): custody figures for Settings › Collection (Admin/Manager; custody_metric re-checks the role). */
export type CustodyMetric = { reviewed: number; placed_2d: number; ready_to_dispatched_median_days: number | null; held_now: number };

export async function custodyMetricAs(from: string, to: string): Promise<CustodyMetric> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("custody_metric", { p_from: from, p_to: to });
  if (error) {
    console.error("custody.metric_failed", { code: error.code });
    throw new Error("Could not load the custody figures.");
  }
  return data as CustodyMetric;
}

/** "92%" of reviewed hard copies placed within 2 working days; null when none were reviewed. */
export const placedPct = (m: CustodyMetric) => (m.reviewed ? Math.round((m.placed_2d / m.reviewed) * 100) : null);
