"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { log } from "@/lib/log";
import { usernameToEmail, USERNAME_RE } from "@/lib/constants";
import { ADMIN_DEPARTMENT, DEPARTMENT_KEYS } from "@/lib/departments";
import { provisionEmployeeIdentity, setEmployeeIdentityActive } from "@/lib/identity-provisioning";

export interface EmployeeFormState {
  error?: string;
  ok?: string;
}

/**
 * Load a target employee profile ONLY if it belongs to the admin's company
 * (Constitution §5: never mutate by a bare id supplied from the browser — confirm
 * the record belongs to an authorised company first). Returns null if the target is
 * missing or in another company, so the caller must treat null as "forbidden".
 */
async function targetInAdminCompany(
  userId: string,
  companyId: string,
): Promise<{ id: string; username: string } | null> {
  if (!userId) return null;
  const { data } = await supabaseAdmin()
    .from("profiles")
    .select("id, username")
    .eq("id", userId)
    .eq("company_id", companyId)
    .maybeSingle();
  return data ?? null;
}

/** Create an employee: auth user (username→synthetic email) + profile row. */
export async function createEmployee(
  _prev: EmployeeFormState,
  formData: FormData,
): Promise<EmployeeFormState> {
  const admin = await requireAdmin();

  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const department = String(formData.get("department") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const isAdmin = formData.get("is_admin") === "on";

  if (!USERNAME_RE.test(username))
    return { error: "Username must be 3–32 chars: lowercase letters, digits, . _ -" };
  if (!DEPARTMENT_KEYS.includes(department)) return { error: "Choose a valid department." };
  // The admin dashboard gates on admin RIGHTS, not on the department. Someone placed in the
  // admin department without the rights has no page they may open, so refuse the combination
  // at creation rather than creating an employee who cannot use the app.
  if (department === ADMIN_DEPARTMENT && !isAdmin)
    return { error: "The Admin / Owner department is the control panel — tick “Administrator”, or choose the department this person actually works in." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  const db = supabaseAdmin();

  // Reject duplicate username up front (also enforced by the unique constraint).
  const { data: existing } = await db.from("profiles").select("id").eq("username", username).maybeSingle();
  if (existing) return { error: `Username “${username}” is already taken.` };

  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email: usernameToEmail(username),
    password,
    email_confirm: true,
    user_metadata: { username, full_name: fullName },
  });
  if (createErr || !created.user) return { error: createErr?.message ?? "Could not create the account." };

  const { error: profileErr } = await db.from("profiles").insert({
    id: created.user.id,
    company_id: admin.companyId,
    username,
    full_name: fullName || null,
    department,
    is_admin: isAdmin,
    created_by: admin.userId,
  });
  if (profileErr) {
    // Roll back the auth user so we never leave a login without a profile.
    await db.auth.admin.deleteUser(created.user.id);
    return { error: `Could not save the profile: ${profileErr.message}` };
  }

  // MEMBERSHIP IDENTITY (identity plan step 5). A profile alone is invisible to
  // has_membership()/has_capability() and to lib/access.ts, so an employee created without it
  // is silently denied once RLS becomes the enforcement path. Fail CLOSED: roll the whole
  // creation back rather than leave a half-provisioned employee behind.
  const identity = await provisionEmployeeIdentity(db, {
    userId: created.user.id,
    companyId: admin.companyId,
    fullName: fullName || null,
    isAdmin,
    isActive: true,
  });
  if (!identity.ok) {
    await db.from("profiles").delete().eq("id", created.user.id).eq("company_id", admin.companyId);
    await db.auth.admin.deleteUser(created.user.id);
    return { error: `Could not grant company access: ${identity.error}` };
  }

  await writeAudit({
    companyId: admin.companyId,
    actorId: admin.userId,
    action: "employee.created",
    entityType: "profile",
    entityId: created.user.id,
    payload: { username, department, is_admin: isAdmin, membership_roles: identity.roles },
  });
  revalidatePath("/app/admin/employees");
  return { ok: `Created ${username} (${department}).` };
}

/** Activate / deactivate an employee (deactivated accounts cannot sign in). */
export async function setEmployeeActive(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const active = formData.get("active") === "true";

  // Company-scoped: only act on employees within the admin's own company.
  const target = await targetInAdminCompany(userId, admin.companyId);
  if (!target) return;

  const db = supabaseAdmin();
  await db
    .from("profiles")
    .update({ is_active: active })
    .eq("id", userId)
    .eq("company_id", admin.companyId);
  // A suspension has to reach BOTH identity models, or has_membership() still grants access.
  const mirrored = await setEmployeeIdentityActive(db, { userId, companyId: admin.companyId, isActive: active });
  if (!mirrored.ok) {
    log("error", "membership status mirror failed", {
      event: "employee.membership_mirror_failed",
      userId,
      companyId: admin.companyId,
      error: mirrored.error ?? null,
    });
  }
  await writeAudit({
    companyId: admin.companyId,
    actorId: admin.userId,
    action: active ? "employee.activated" : "employee.deactivated",
    entityType: "profile",
    entityId: userId,
  });
  revalidatePath("/app/admin/employees");
}

/** Inline (form-post) password reset used from the employee table row. */
export async function setEmployeePassword(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return;

  const target = await targetInAdminCompany(userId, admin.companyId);
  if (!target) return;

  await supabaseAdmin().auth.admin.updateUserById(userId, { password });
  await writeAudit({
    companyId: admin.companyId,
    actorId: admin.userId,
    action: "employee.password_reset",
    entityType: "profile",
    entityId: userId, // never log the password value
  });
  revalidatePath("/app/admin/employees");
}

/** Admin-set a new password for an employee. */
export async function resetEmployeePassword(
  _prev: EmployeeFormState,
  formData: FormData,
): Promise<EmployeeFormState> {
  const admin = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!userId) return { error: "Missing employee." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  // Company-scoped: reject a target outside the admin's company.
  const target = await targetInAdminCompany(userId, admin.companyId);
  if (!target) return { error: "Employee not found in your company." };

  const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, { password });
  if (error) return { error: error.message };
  await writeAudit({
    companyId: admin.companyId,
    actorId: admin.userId,
    action: "employee.password_reset",
    entityType: "profile",
    entityId: userId, // never log the password value
  });
  return { ok: "Password updated." };
}
