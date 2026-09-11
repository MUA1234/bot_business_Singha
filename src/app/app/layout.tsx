import type { ReactNode } from "react";
import { requireProfile } from "@/lib/auth";
import { navDepartmentFor } from "@/lib/departments";
import { AppShell } from "@/components/AppShell";

/**
 * Shell for every authenticated dashboard. Admins get the admin navigation (which
 * links into every other dashboard); members get only their department's nav.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const profile = await requireProfile();
  // Mirrors `landingPathFor`: an employee in the admin department WITHOUT admin rights
  // must not be shown the admin nav, every link of which would bounce them away.
  const dept = navDepartmentFor(profile);
  const nav = dept.nav;

  return (
    <AppShell
      nav={nav}
      username={profile.username}
      departmentLabel={dept.label}
      isAdmin={profile.isAdmin}
    >
      {children}
    </AppShell>
  );
}
