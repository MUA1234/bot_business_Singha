/**
 * Session + profile helpers used by every protected page and server action.
 * A "session profile" ties the Supabase auth user to their employee profile
 * (department, admin flag). Pages call `requireProfile()`; the admin panel calls
 * `requireAdmin()`.
 */
import { redirect } from "next/navigation";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

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

  // Read the profile with the service client (server-only) for reliability.
  const { data: profile } = await supabaseAdmin()
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

/** Require admin, else send to their own dashboard (or login). */
export async function requireAdmin(): Promise<SessionProfile> {
  const p = await requireProfile();
  if (!p.isAdmin) redirect(`/app/${p.department}`);
  return p;
}

/** A member of a specific department, or admin. Else bounce to own dashboard. */
export async function requireDepartment(department: string): Promise<SessionProfile> {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== department) redirect(`/app/${p.department}`);
  return p;
}
