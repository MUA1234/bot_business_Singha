/**
 * Identity provisioning for a newly created employee.
 *
 * Why this exists. Two identity models coexist during the staged cutover
 * (`docs/architecture-v2/IDENTITY_UNIFICATION_PLAN.md`): the legacy `profiles` row that
 * `lib/auth.ts` reads today, and the `users` → `memberships` → `membership_roles` model that
 * `has_membership()` / `has_capability()` / `lib/access.ts` treat as the access source of
 * truth (D-019). Migration 0010 backfilled the second model from the first **once, at
 * migration time**, and the admin panel was never taught to write it. So every employee
 * created afterwards existed only as a profile: able to sign in, but invisible to the
 * capability layer — and denied outright the moment `RLS_READS`/`RLS_WRITES` flip. Five live
 * accounts were in that state.
 *
 * Step 5 of the identity plan ("point admin writes at memberships") is exactly this module.
 * The row builders are pure so the role mapping is unit-tested without a database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The membership role vocabulary this app grants (migration 0001/0010 `roles.key`). */
export const ROLE_STAFF = "staff_submitter";
export const ROLE_SYSTEM_ADMIN = "system_administrator";

export interface EmployeeIdentity {
  userId: string;
  companyId: string;
  fullName?: string | null;
  isAdmin: boolean;
  isActive?: boolean;
}

/**
 * The membership roles an employee gets. Mirrors migration 0010's backfill exactly:
 * everyone submits; an admin additionally administers. Pure.
 */
export function rolesForEmployee(isAdmin: boolean): string[] {
  return isAdmin ? [ROLE_STAFF, ROLE_SYSTEM_ADMIN] : [ROLE_STAFF];
}

/** Membership status that corresponds to a profile's active flag. Pure. */
export function membershipStatusFor(isActive: boolean): "active" | "suspended" {
  return isActive ? "active" : "suspended";
}

export type ProvisionResult =
  | { ok: true; membershipId: string; roles: string[] }
  | { ok: false; error: string };

/**
 * Create (or repair) the membership identity for an employee. Idempotent: safe to call for
 * an employee who already has a membership, so it doubles as a repair path.
 *
 * Uses the service client — `users`/`memberships`/`membership_roles` are service-only tables
 * — and scopes every write with an explicit `company_id` because the service role bypasses
 * RLS (CLAUDE.md company-isolation rule).
 */
export async function provisionEmployeeIdentity(
  db: SupabaseClient,
  e: EmployeeIdentity,
): Promise<ProvisionResult> {
  const isActive = e.isActive ?? true;

  // 1. `users` mirrors auth.users and is the FK target for memberships.
  const userUpsert = await db
    .from("users")
    .upsert({ id: e.userId, full_name: e.fullName ?? null, is_active: isActive }, { onConflict: "id" });
  if (userUpsert.error) return { ok: false, error: `users: ${userUpsert.error.message}` };

  // 2. One membership per (company, user) — the unique constraint makes this idempotent.
  const memUpsert = await db
    .from("memberships")
    .upsert(
      { company_id: e.companyId, user_id: e.userId, status: membershipStatusFor(isActive) },
      { onConflict: "company_id,user_id" },
    )
    .select("id")
    .maybeSingle();
  if (memUpsert.error || !memUpsert.data) {
    return { ok: false, error: `memberships: ${memUpsert.error?.message ?? "no row returned"}` };
  }
  const membershipId = memUpsert.data.id as string;

  // 3. Roles. Composite PK (membership_id, role_key) makes the insert idempotent.
  const roles = rolesForEmployee(e.isAdmin);
  const roleUpsert = await db
    .from("membership_roles")
    .upsert(
      roles.map((role_key) => ({ membership_id: membershipId, company_id: e.companyId, role_key })),
      { onConflict: "membership_id,role_key" },
    );
  if (roleUpsert.error) return { ok: false, error: `membership_roles: ${roleUpsert.error.message}` };

  return { ok: true, membershipId, roles };
}

/**
 * Mirror an activate/deactivate onto the membership model. A deactivated profile that keeps
 * an `active` membership would still satisfy `has_membership()` once RLS is the enforcement
 * path — the suspension has to reach both models or it is not a suspension.
 */
export async function setEmployeeIdentityActive(
  db: SupabaseClient,
  e: { userId: string; companyId: string; isActive: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const status = membershipStatusFor(e.isActive);
  const mem = await db
    .from("memberships")
    .update({ status })
    .eq("user_id", e.userId)
    .eq("company_id", e.companyId);
  if (mem.error) return { ok: false, error: `memberships: ${mem.error.message}` };

  const usr = await db.from("users").update({ is_active: e.isActive }).eq("id", e.userId);
  if (usr.error) return { ok: false, error: `users: ${usr.error.message}` };
  return { ok: true };
}
