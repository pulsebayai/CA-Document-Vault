import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "@/lib/security/csp";

const PUBLIC_PATHS = ["/login", "/auth"];

/**
 * Refreshes the Supabase session cookie and does an *optimistic* redirect for signed-out users.
 * The authoritative check (active staff record) happens in requireStaff() on every page/action.
 */
export async function updateSession(request: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NEXT_PUBLIC_SUPABASE_URL!);
  // Next.js reads the nonce from the request's CSP header and applies it to its own scripts.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };
  const withCsp = (res: NextResponse) => { res.headers.set("Content-Security-Policy", csp); return res; };
  let response = forward();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = forward();
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Verifies the JWT (do not trust getSession() in server code).
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return withCsp(NextResponse.redirect(url));
  }
  if (signedIn && path === "/login" && !request.nextUrl.searchParams.has("reason")) {
    const url = request.nextUrl.clone();
    url.pathname = "/clients";
    url.search = "";
    return withCsp(NextResponse.redirect(url));
  }
  return response;
}
