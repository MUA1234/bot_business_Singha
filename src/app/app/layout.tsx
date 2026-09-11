import type { ReactNode } from "react";
import { requireProfile } from "@/lib/auth";
// `navDepartmentFor` from main, the spatial shell from the candidate. Main's fix is about WHICH
// nav a person sees; the candidate's change is about which shell renders it. They are orthogonal,
// and taking either side whole would have discarded the other.
import { navDepartmentFor } from "@/lib/departments";
import { loadOsShellData } from "@/lib/os-shell-data";
import { SpatialShell } from "@/components/os/SpatialShell";

/**
 * Shell for every authenticated dashboard.
 *
 * Entitlement is unchanged: admins get the admin navigation (which links into
 * every other dashboard); members get only their own department's nav. The
 * Spatial Executive OS shell re-presents exactly that list as a command rail —
 * it never adds a destination the department catalog did not already grant.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const profile = await requireProfile();
  // Mirrors `landingPathFor`: an employee in the admin DEPARTMENT without admin RIGHTS must not
  // be shown the admin nav, every link of which would bounce them away. The candidate's
  // `getDepartment(profile.isAdmin ? "admin" : profile.department)` had exactly that defect — a
  // non-admin whose department is "admin" fell through to the admin nav.
  const dept = navDepartmentFor(profile);
  const nav = dept.nav;
  const shell = await loadOsShellData(profile);

  return (
    <SpatialShell
      nav={nav}
      username={profile.username}
      departmentLabel={dept.label}
      isAdmin={profile.isAdmin}
      companyName={shell.companyName}
      branchLabel={shell.branchLabel}
      unreadCount={shell.unreadCount}
      railCounts={shell.railCounts}
      aiConfigured={shell.aiConfigured}
    >
      {children}
    </SpatialShell>
  );
}
