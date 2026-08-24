import { env } from "@/config/env";
import { SpatialWorkspaceShell } from "./SpatialWorkspaceShell";
import { EmptyState } from "@/components/ui";

export const metadata = { title: "Spatial Workspace — Singha Central" };

/**
 * Spatial Operations Workspace entry point. Gated by the `NEXT_PUBLIC_SPATIAL_WORKSPACE`
 * feature flag (default OFF). The shell itself requires admin.
 */
export default function SpatialPage() {
  if (!env.flags.spatialWorkspace()) {
    return (
      <div className="main">
        <EmptyState
          title="Spatial workspace is not enabled"
          description="Set NEXT_PUBLIC_SPATIAL_WORKSPACE=on to activate the V2 spatial workspace. Existing dashboards continue to work normally."
          icon="layout"
        />
      </div>
    );
  }

  return <SpatialWorkspaceShell />;
}
