import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Deactivated / unknown users land here from requireStaff(). Route handlers may clear cookies
 * (Server Components may not), so the session is ended here, then the user sees the login notice.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/login?reason=removed", request.url));
}
