import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * 19 (spec AC-7): staff of a suspended firm land here from requireStaff(). Like /auth/removed, a route handler ends
 * the session (Server Components may not clear cookies), then the login page shows the "paused" notice.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/login?reason=paused", request.url));
}
