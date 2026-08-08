/**
 * WP1 read-path cutover client. Returns the authenticated, RLS-enforced client
 * (`supabaseServer`) when the cutover is enabled, else the service-role client
 * (`supabaseAdmin`) — today's behavior. This lets the entire read surface move to the
 * new pattern with ZERO behavior change by default; the owner flips `RLS_READS=on` on
 * staging to validate that RLS returns the same company-scoped data for every role,
 * then makes it the default.
 *
 * Live company-isolation tests (tests/integration) prove RLS enforces isolation at the
 * database; this flag lets that enforcement take over the app's reads gradually and
 * reversibly. Use ONLY for reads — writes keep their explicit client.
 */
import { supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/** True when the RLS read cutover is enabled. Default (unset) = off = service role. */
export function rlsReadsEnabled(): boolean {
  return process.env.RLS_READS === "on";
}

/**
 * The client to use for company-scoped READS in pages/read paths. RLS-enforced when
 * the cutover is on; service-role (current behavior) otherwise. Never use for writes.
 */
export function supabaseReadClient(): SupabaseClient {
  return rlsReadsEnabled() ? supabaseServer() : supabaseAdmin();
}

/** True when the RLS write cutover is enabled. Default (unset) = off = service role. */
export function rlsWritesEnabled(): boolean {
  return process.env.RLS_WRITES === "on";
}

/**
 * The client to use for company-scoped WRITES in ordinary user actions. RLS-enforced
 * when the write cutover is on (a user can only write their own company's rows —
 * migration 0034), service-role otherwise. App-layer capability checks still run first.
 */
export function supabaseWriteClient(): SupabaseClient {
  return rlsWritesEnabled() ? supabaseServer() : supabaseAdmin();
}

/**
 * §WP2 — the client for CAPABILITY-ENFORCED FINANCIAL RPCs (post/settle/reverse/
 * reimburse/approve). ALWAYS the authenticated client, regardless of RLS_WRITES, so
 * `auth.uid()` is populated inside the SECURITY DEFINER RPC and it enforces the caller's
 * database capability + records the real actor. The RPC still performs its controlled
 * internal writes as the definer, so it works even while general RLS_WRITES is off.
 * NEVER routes a user-initiated financial RPC through the service role.
 */
export function supabaseRpcClient(): SupabaseClient {
  return supabaseServer();
}
