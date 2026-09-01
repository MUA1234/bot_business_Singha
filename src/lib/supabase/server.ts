/**
 * Supabase clients for the App Router (cookie-based sessions via @supabase/ssr).
 *   - `supabaseServer()` — RLS-enforced, bound to the signed-in user's cookies.
 *     Use in server components, server actions and route handlers.
 *   - `supabaseAdmin()`  — service-role, bypasses RLS. Server-only, for admin
 *     operations (creating employees) and trusted writes. NEVER expose to the browser.
 *
 * Uses NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY for the user client
 * (both are public) and SUPABASE_SERVICE_ROLE_KEY for the admin client.
 */
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Next.js patches the global `fetch` and stores GET responses in its Data Cache. Every
 * Supabase REST read is a GET, so without an explicit opt-out the server can serve a
 * CACHED row set while the database has already moved on — and the route still looks
 * healthy because it re-runs and stamps a fresh timestamp.
 *
 * Observed in production on 2026-09-01: after the outbox row was delivered and the table
 * held ZERO failed rows, `/api/health` kept reporting `outboxFailed: 1` indefinitely (still
 * wrong 90s later, across separate deployments and cache-busted URLs), which drove the
 * overall level to `crit`. The same cache sits under every dashboard read, so a department
 * page could show yesterday's invoices and give no sign anything was wrong.
 *
 * Business state is never cacheable: force `no-store` on every request both clients make.
 * This is the read-path equivalent of the "never a misleading value" rule the health
 * endpoint already applies to unavailable sources.
 */
export const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function publicUrl(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!v) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  return v;
}
function anonKey(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!v) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return v;
}

/** RLS-enforced client bound to the request's auth cookies. */
export function supabaseServer(): SupabaseClient {
  const cookieStore = cookies();
  return createServerClient(publicUrl(), anonKey(), {
    global: { fetch: noStoreFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — cookies are read-only there. The
          // middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

/** Service-role client. Server-only. Bypasses RLS — always filter by company_id. */
let _admin: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = process.env.SUPABASE_URL || publicUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  _admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStoreFetch },
  });
  return _admin;
}
