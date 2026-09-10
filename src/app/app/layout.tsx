import type { ReactNode } from "react";
import { requireProfile } from "@/lib/auth";
import { getDepartment } from "@/lib/departments";
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
  const dept = getDepartment(profile.isAdmin ? "admin" : profile.department);
  const nav = dept?.nav ?? [];
  const shell = await loadOsShellData(profile);

  return (
    <SpatialShell
      nav={nav}
      username={profile.username}
      departmentLabel={dept?.label ?? profile.department}
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
