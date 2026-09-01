/**
 * Refreshes the Supabase auth session on every request (keeps cookies fresh) and
 * gates the /app area: no session → redirect to /login. Fine-grained department
 * checks happen in the pages via requireProfile()/requireAdmin().
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // If Supabase isn't configured yet, don't hard-fail the whole site.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Bound the auth round-trip. This call runs on EVERY /app and /login request, and with no
  // timeout a slow or sleeping database turns every page into a hang — observed in production
  // as four "function stopped, no initial response within 25s" errors on /middleware affecting
  // real users. On a timeout we treat the request as unauthenticated: a signed-in user is sent
  // to /login (recoverable, and the page itself re-checks) rather than left staring at a
  // spinner. Failing closed is also the safe direction for an auth gate.
  const AUTH_TIMEOUT_MS = 5_000;
  let user: { id: string } | null = null;
  try {
    const result = await Promise.race([
      supabase.auth.getUser(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("auth_timeout")), AUTH_TIMEOUT_MS)),
    ]);
    user = result.data.user;
  } catch {
    user = null;
  }

  const path = request.nextUrl.pathname;
  if (path.startsWith("/app") && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", path);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Run on app + auth routes; skip static assets and the public quote page.
  matcher: ["/app/:path*", "/login"],
};
