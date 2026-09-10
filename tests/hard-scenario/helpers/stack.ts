/**
 * Hard-scenario campaign — live stack helper.
 *
 * Every scenario runs against the REAL services: GoTrue issues a genuine JWT for a
 * genuine password sign-in, and PostgREST enforces the real RLS policies with that JWT.
 * Nothing here bypasses authentication or authorisation, and nothing sets a role or a
 * claim by hand — if a read is permitted in a test, it is permitted in the product.
 *
 * The suite SKIPS (rather than passes) when the stack is not running, so a missing
 * environment can never be mistaken for a green campaign.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const GATEWAY = process.env.HST_GATEWAY_URL ?? "http://127.0.0.1:54321";
export const APP = process.env.HST_APP_URL ?? "http://127.0.0.1:3241";
export const ANON = process.env.HST_ANON_KEY ?? "";
export const SERVICE = process.env.HST_SERVICE_KEY ?? "";
export const FIXTURE_PASSWORD = process.env.DEV_FIXTURE_PASSWORD ?? "";

export const stackConfigured = Boolean(ANON && SERVICE && FIXTURE_PASSWORD);

/** Tenant A — seeded by scripts/verify/dev-fixture-seed.mjs. */
export const TENANT_A = {
  company: "0000f1de-0000-4000-8000-000000000001",
  owner: "fixture.owner@singha.local",
  finance: "fixture.finance@singha.local",
  staff: "fixture.staff@singha.local",
  sales: "fixture.sales@singha.local",
} as const;

/** Tenant B — seeded by scripts/hard-scenario/seed-tenant-b.mjs. */
export const TENANT_B = {
  company: "0000f1de-0000-4000-8000-0000000000b2",
  owner: "fixtureb.owner@singha.local",
  finance: "fixtureb.finance@singha.local",
  staff: "fixtureb.staff@singha.local",
  secretCustomer: "0000f1de-0000-4000-8000-b20000000200",
  secretProject: "0000f1de-0000-4000-8000-b20000000300",
  secretTask: "0000f1de-0000-4000-8000-b20000000400",
} as const;

/** A service-role client. Used ONLY to arrange fixtures and to read ground truth. */
export function serviceClient(): SupabaseClient {
  return createClient(GATEWAY, SERVICE, { auth: { persistSession: false } });
}

/**
 * Sign in for real and return a client bound to that user's JWT.
 *
 * This is the whole point: the returned client carries an `authenticated` token, so
 * every subsequent request is filtered by the same RLS policies the application relies
 * on. There is no service-role shortcut and no hand-made claim.
 */
export async function signInAs(email: string): Promise<{ db: SupabaseClient; userId: string; accessToken: string }> {
  const anonDb = createClient(GATEWAY, ANON, { auth: { persistSession: false } });
  const { data, error } = await anonDb.auth.signInWithPassword({ email, password: FIXTURE_PASSWORD });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message ?? "no session"}`);
  const accessToken = data.session.access_token;
  const db = createClient(GATEWAY, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  return { db, userId: data.user!.id, accessToken };
}

/** A raw PostgREST call with an explicit token — for probing the API boundary directly. */
export async function rest(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${GATEWAY}/rest/v1${path}`, {
    ...init,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  return { status: res.status, body };
}

/** An application request with the browser's auth cookies absent — i.e. anonymous. */
export async function appGet(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${APP}${path}`, { redirect: "manual", ...init });
}
