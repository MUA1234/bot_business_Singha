/**
 * Supabase clients. Two flavours:
 *   - service client: server-only, bypasses RLS (SUPABASE_SERVICE_ROLE_KEY).
 *     Used by trusted server jobs (webhook ingestion, posting). NEVER shipped to
 *     the browser.
 *   - anon client: RLS-enforced, for user-scoped reads.
 *
 * Clients are created lazily so importing this module never throws when env is
 * absent (e.g. in unit tests that don't touch the DB).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/config/env";

let _service: SupabaseClient | null = null;

/** Server-only, RLS-bypassing client. Guard every query with an explicit company_id. */
export function serviceClient(): SupabaseClient {
  if (_service) return _service;
  _service = createClient(env.supabase.url(), env.supabase.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}

/** RLS-enforced client bound to a user's access token. */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(env.supabase.url(), env.supabase.anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
