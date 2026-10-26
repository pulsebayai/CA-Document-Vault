import { randomUUID, timingSafeEqual } from "node:crypto";
import { sweepOrphanObjects } from "@/lib/documents/storage";

// Feature 10 step 11 — daily storage sweep (Vercel Cron, vercel.json). Removes stored files that no document version
// points at and are older than 24 hours: uploads whose save never happened (03) or whose link registration was refused
// or abandoned (10). Vercel sends `Authorization: Bearer <CRON_SECRET>`; without a matching secret (or with none set)
// the route refuses and does nothing. Logs a count and a request ID only.

export const dynamic = "force-dynamic";

function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 16 || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorised(request.headers.get("authorization"))) {
    return Response.json({ error: "UNAUTHORISED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const requestId = randomUUID();
  try {
    const removed = await sweepOrphanObjects();
    console.info("storage.sweep", { removed, requestId });
    return Response.json({ removed }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("storage.sweep_failed", { error: e instanceof Error ? e.message : "error", requestId });
    return Response.json({ error: "SWEEP_FAILED", requestId }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
