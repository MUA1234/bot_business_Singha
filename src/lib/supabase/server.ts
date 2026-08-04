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
  });
  return _admin;
}
