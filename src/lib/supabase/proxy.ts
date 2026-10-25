import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "@/lib/security/csp";

const PUBLIC_PATHS = ["/login", "/auth", "/u"]; // 10: /u is the client upload page (token in the URL fragment)

/** Feature 10 AC-10: the upload page is never cached, indexed or referred from. */
function uploadPageHeaders(res: NextResponse, path: string) {
  if (path === "/u" || path.startsWith("/u/")) {
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    res.headers.set("Cache-Control", "no-store");
  }
  return res;
}

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
  // /u is public only as exactly /u (review N6): a future /u/* route is not public by accident.
  const isPublic = path === "/u" || PUBLIC_PATHS.some((p) => p !== "/u" && (path === p || path.startsWith(`${p}/`)));

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return withCsp(NextResponse.redirect(url));
  }
  if (path === "/u" || path.startsWith("/u/")) return uploadPageHeaders(response, path);
  if (signedIn && path === "/login" && !request.nextUrl.searchParams.has("reason")) {
    const url = request.nextUrl.clone();
    url.pathname = "/today"; // 06 AC-1: a signed-in user opening /login lands on Today
    url.search = "";
    return withCsp(NextResponse.redirect(url));
  }
  return response;
}
