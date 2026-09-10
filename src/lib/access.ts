/**
 * WP1 central access helpers (NEXT_PHASE_DEVELOPER_BRIEF §WP1.2).
 *
 * These read the MEMBERSHIP model (migration 0010/0023) as the access source of
 * truth and use the authenticated, RLS-bound client — NOT the service role. They are
 * the single place capabilities and company scope are decided; pages/actions must use
 * these instead of scattered `department === "finance"` / `is_admin` comparisons.
 *
 * Rollout is incremental: this module is added now and adopted page-group by
 * page-group, each cutover staged + owner-approved. Nothing here runs the service
 * role, so cross-company leakage cannot hide behind a bypass.
 */
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import type { Approver } from "@/policy/authority";
import { role, permission, type Role, type Permission } from "@/schemas/approval-policy";

export class AccessError extends Error {
  constructor(
    message: string,
    readonly code: "unauthenticated" | "no_membership" | "suspended" | "forbidden" | "not_found",
  ) {
    super(message);
    this.name = "AccessError";
  }
}

export interface Membership {
  membershipId: string;
  userId: string;
  companyId: string;
  status: "active" | "suspended" | "ended";
  roleKeys: string[];
}

/**
 * Roles held by one membership, read as a SEPARATE query.
 *
 * It cannot be a PostgREST embed. `membership_roles` carries two foreign keys
 * into `memberships` — the original single-column `membership_id` FK and the
 * composite `(membership_id, company_id)` FK added for tenant integrity — so
 * `memberships.select("…, membership_roles(role_key)")` is ambiguous and
 * PostgREST refuses it with "more than one relationship was found".
 *
 * That refusal is returned as an ERROR with `data: null`, and both call sites
 * treated a null result as "this user has no membership". The effect was that
 * `getApproverForUser` returned null for EVERY user, `checkSeparationOfDuties`
 * was never reached, and the approvals screen told every finance approver that
 * they were "not an approver" — no approval could be granted through the UI at
 * all. Two plain queries cannot become ambiguous when another FK is added.
 */
async function roleKeysFor(db: SupabaseClient, membershipId: string): Promise<string[]> {
  const { data } = await db
    .from("membership_roles")
    .select("role_key")
    .eq("membership_id", membershipId);
  return (data ?? []).map((r: { role_key: string }) => r.role_key);
}

/** Resolve the signed-in user's active membership (optionally for a given company). */
export async function getMembership(companyId?: string): Promise<Membership | null> {
  const db = supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return null;

  let q = db
    .from("memberships")
    .select("id, user_id, company_id, status")
    .eq("user_id", user.id)
    .eq("status", "active");
  if (companyId) q = q.eq("company_id", companyId);

  const { data: rows } = await q;
  const row = rows?.[0];
  if (!row) return null;

  const roleKeys = await roleKeysFor(db, row.id as string);
  return {
    membershipId: row.id as string,
    userId: row.user_id as string,
    companyId: row.company_id as string,
    status: row.status as Membership["status"],
    roleKeys,
  };
}

/** Require an active membership or redirect to /login. For pages. */
export async function requireMembership(companyId?: string): Promise<Membership> {
  const m = await getMembership(companyId);
  if (!m) redirect("/login");
  return m;
}

/** Non-redirecting variant for server actions; throws AccessError. */
export async function requireMembershipAction(companyId?: string): Promise<Membership> {
  const m = await getMembership(companyId);
  if (!m) throw new AccessError("No active membership", "no_membership");
  return m;
}

/** True if the given membership holds a capability (permission key) in its company. */
export async function membershipHasCapability(m: Membership, capability: string): Promise<boolean> {
  if (m.roleKeys.length === 0) return false;
  const db = supabaseServer();
  const { data } = await db
    .from("role_permissions")
    .select("permission_key, role_key")
    .in("role_key", m.roleKeys)
    .eq("permission_key", capability)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Build an Approver view for the separation-of-duties engine from the membership model.
 * Returns null when the user has no active membership in the company. Pure read, no side effects.
 */
export async function getApproverForUser(userId: string, companyId: string): Promise<Approver | null> {
  const db = supabaseServer();
  const { data: mems } = await db
    .from("memberships")
    .select("id, status")
    .eq("user_id", userId)
    .eq("company_id", companyId);
  const active = (mems ?? []).find((m: any) => m.status === "active");
  if (!active) return null;
  const allowedRoles = new Set(role.options as readonly string[]);
  // Separate query — see roleKeysFor: an embed here is ambiguous and returns an
  // error, which previously made every approver look like a non-approver.
  const roleKeys = (await roleKeysFor(db, active.id as string)).filter((r): r is Role =>
    allowedRoles.has(r),
  );
  if (roleKeys.length === 0) return { user_id: userId, roles: [], permissions: [] };
  const allowedPerms = new Set(permission.options as readonly string[]);
  const { data: perms } = await db
    .from("role_permissions")
    .select("permission_key")
    .in("role_key", roleKeys);
  const permissions = [...new Set((perms ?? []).map((p: any) => p.permission_key as string).filter((p: string): p is Permission => allowedPerms.has(p)))];
  return { user_id: userId, roles: roleKeys, permissions };
}

/**
 * Require a capability. Deterministic gate before any sensitive action.
 * `scope` (companyId) defaults to the caller's active membership company.
 */
export async function requireCapability(capability: string, scope?: string): Promise<Membership> {
  const m = await requireMembershipAction(scope);
  const ok = await membershipHasCapability(m, capability);
  if (!ok) throw new AccessError(`Missing capability: ${capability}`, "forbidden");
  return m;
}

/**
 * Fetch a company-scoped record by id and prove it belongs to the caller's company.
 * Uses the RLS client, so a cross-company id simply returns nothing → not_found.
 * Never mutate by bare id without going through this (or an equivalent).
 */
export async function requireCompanyRecord<T = Record<string, unknown>>(
  table: string,
  id: string,
  companyId: string,
): Promise<T> {
  const db = supabaseServer();
  const { data } = await db.from(table).select("*").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!data) throw new AccessError(`${table} ${id} not found in company`, "not_found");
  return data as T;
}
