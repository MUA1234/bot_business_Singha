"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { usernameToEmail, USERNAME_RE } from "@/lib/constants";
import { DEPARTMENT_KEYS } from "@/lib/departments";

export interface EmployeeFormState {
  error?: string;
  ok?: string;
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

  revalidatePath("/app/admin/employees");
  return { ok: `Created ${username} (${department}).` };
}

/** Activate / deactivate an employee (deactivated accounts cannot sign in). */
export async function setEmployeeActive(formData: FormData): Promise<void> {
  await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const active = formData.get("active") === "true";
  if (!userId) return;
  await supabaseAdmin().from("profiles").update({ is_active: active }).eq("id", userId);
  revalidatePath("/app/admin/employees");
}

/** Inline (form-post) password reset used from the employee table row. */
export async function setEmployeePassword(formData: FormData): Promise<void> {
  await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!userId || password.length < 8) return;
  await supabaseAdmin().auth.admin.updateUserById(userId, { password });
  revalidatePath("/app/admin/employees");
}

/** Admin-set a new password for an employee. */
export async function resetEmployeePassword(
  _prev: EmployeeFormState,
  formData: FormData,
): Promise<EmployeeFormState> {
  await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!userId) return { error: "Missing employee." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, { password });
  if (error) return { error: error.message };
  return { ok: "Password updated." };
}
