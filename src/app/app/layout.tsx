import type { ReactNode } from "react";
import { requireProfile } from "@/lib/auth";
import { getDepartment } from "@/lib/departments";
import { AppShell } from "@/components/AppShell";

/**
 * Shell for every authenticated dashboard. Admins get the admin navigation (which
 * links into every other dashboard); members get only their department's nav.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const profile = await requireProfile();
  const dept = getDepartment(profile.isAdmin ? "admin" : profile.department);
  const nav = dept?.nav ?? [];

  return (
    <AppShell
      nav={nav}
      username={profile.username}
      departmentLabel={dept?.label ?? profile.department}
      isAdmin={profile.isAdmin}
    >
      {children}
    </AppShell>
  );
}
