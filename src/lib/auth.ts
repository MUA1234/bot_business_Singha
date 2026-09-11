/**
 * Session + profile helpers used by every protected page and server action.
 * A "session profile" ties the Supabase auth user to their employee profile
 * (department, admin flag). Pages call `requireProfile()`; the admin panel calls
 * `requireAdmin()`.
 */
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
// The candidate's RLS-respecting read client, NOT `supabaseAdmin`. Main reached for the admin
// client here; every read in this file is the signed-in caller asking about themselves, so it must
// go through the path RLS governs — otherwise `RLS_READS=on` changes nothing for the one module
// that decides who the caller is.
import { supabaseReadClient } from "@/lib/supabase/read";
// From main: the landing path is resolved from the person's department instead of being hardcoded
// to one screen, which is what locked non-admin departments out.
import { landingPathFor } from "@/lib/departments";

export interface SessionProfile {
  userId: string;
  username: string;
  fullName: string | null;
  department: string;
  isAdmin: boolean;
  companyId: string;
}

/** Current signed-in employee, or null. Never throws. */
export async function getProfile(): Promise<SessionProfile | null> {
  const {
    data: { user },
  } = await supabaseServer().auth.getUser();
  if (!user) return null;

  // Read the profile through the RLS-aware read client. With RLS_READS off this is
  // still the service-role client; with the cutover on, the database enforces that a
  // user can only read their own profile (or all profiles in their company if admin).
  const { data: profile } = await supabaseReadClient()
    .from("profiles")
    .select("username, full_name, department, is_admin, is_active, company_id")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || !profile.is_active) return null;

  return {
    userId: user.id,
    username: profile.username,
    fullName: profile.full_name,
    department: profile.department,
    isAdmin: profile.is_admin,
    companyId: profile.company_id,
  };
}

/** Require a signed-in employee or redirect to /login. */
export async function requireProfile(): Promise<SessionProfile> {
  const p = await getProfile();
  if (!p) redirect("/login");
  return p;
}

/** Require admin, else send to the page they ARE allowed to open (or login).
 *
 *  The redirect target must be resolved by `landingPathFor`, never `/app/${department}`:
 *  a non-admin whose department is `admin` was bounced back to `/app/admin`, which lands
 *  here again — an infinite redirect that locked the employee out of the whole app. */
export async function requireAdmin(): Promise<SessionProfile> {
  const p = await requireProfile();
  if (!p.isAdmin) redirect(landingPathFor(p));
  return p;
}

/** A member of a specific department, or admin. Else bounce to the page they may open. */
export async function requireDepartment(department: string): Promise<SessionProfile> {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== department) redirect(landingPathFor(p));
  return p;
}

/**
 * WP D central capability resolution (staged identity cutover). Reads the MEMBERSHIP
 * model as the source of truth. Returns:
 *   - "granted"          — an active membership role grants the capability;
 *   - "denied_suspended" — the user has membership(s) here but none active (suspended);
 *   - "denied_no_cap"    — active membership, but no role grants the capability;
 *   - "no_membership"    — no membership rows yet (legacy-only user).
 * This replaces scattered `department === "finance"` string comparisons with one gate.
 */
export type CapabilityResult = "granted" | "denied_suspended" | "denied_no_cap" | "no_membership";

export async function resolveCapability(userId: string, companyId: string, capability: string): Promise<CapabilityResult> {
  const db = supabaseReadClient();
  const { data: mems } = await db.from("memberships").select("id, status").eq("user_id", userId).eq("company_id", companyId);
  if (!mems || mems.length === 0) return "no_membership";
  const activeIds = mems.filter((m) => m.status === "active").map((m) => m.id);
  if (activeIds.length === 0) return "denied_suspended";
  const { data: roles } = await db.from("membership_roles").select("role_key").in("membership_id", activeIds);
  const roleKeys = [...new Set((roles ?? []).map((r) => r.role_key))];
  if (roleKeys.length > 0) {
    const { data: perms } = await db.from("role_permissions").select("permission_key").in("role_key", roleKeys).eq("permission_key", capability).limit(1);
    if ((perms?.length ?? 0) > 0) return "granted";
  }
  return "denied_no_cap";
}

/**
 * Finance access gate for server actions (staged cutover). A membership capability GRANTS
 * access; a suspended member is DENIED; otherwise we fall back to the legacy finance
 * department / admin check so current users are never locked out during rollout. The DB
 * RPCs (migration 0039) enforce the operation-specific capability authoritatively once
 * RLS_WRITES is on — this app-layer gate is defence-in-depth and centralisation.
 */
export async function requireFinanceAccess(capability: string): Promise<SessionProfile> {
  const p = await requireProfile();
  const r = await resolveCapability(p.userId, p.companyId, capability);
  if (r === "granted") return p;
  if (r === "denied_suspended") throw new Error("Access suspended");
  if (p.isAdmin || p.department === "finance") return p; // legacy compatibility during cutover
  throw new Error("Not allowed");
}

/**
 * §WP2 STRICT gate for posting / payment / approval decisions: the membership capability
 * is REQUIRED — there is NO legacy department/admin fallback. A finance_reviewer who can
 * create a draft therefore cannot post. This mirrors the database RPC's own capability
 * check (defence in depth); the DB remains the final authority.
 */
export async function requireCapabilityStrict(capability: string): Promise<SessionProfile> {
  const p = await requireProfile();
  const r = await resolveCapability(p.userId, p.companyId, capability);
  if (r === "granted") return p;
  if (r === "denied_suspended") throw new Error("Access suspended");
  throw new Error(`Missing capability: ${capability}`);
}
