import { requireAdmin } from "@/lib/auth";
import { resolveAllowedModules, loadArrivals } from "./actions";
import { WorkspaceProvider, type InitialWindow } from "@/components/spatial/WorkspaceProvider";
import { SpatialWorkspace } from "@/components/spatial/SpatialWorkspace";
import { CommandCentrePanel } from "@/components/spatial/panels/CommandCentrePanel";
import { TasksPanel } from "@/components/spatial/panels/TasksPanel";
import { ApprovalsPanel } from "@/components/spatial/panels/ApprovalsPanel";
import { AIRecommendationsPanel } from "@/components/spatial/panels/AIRecommendationsPanel";
import FinancePanel from "@/components/spatial/panels/FinancePanel";
import SystemHealthPanel from "@/components/spatial/panels/SystemHealthPanel";

interface PreviewAdmin {
  userId: string;
  companyId: string;
  isAdmin: boolean;
}

interface SpatialWorkspaceShellProps {
  __previewAdmin?: PreviewAdmin;
}

/**
 * Server-side shell for the spatial workspace. It pre-renders the initial windows as
 * server components and passes them to the client `WorkspaceProvider`. The client
 * manager then handles drag, focus, minimise, maximise and docking.
 */
export async function SpatialWorkspaceShell({ __previewAdmin }: SpatialWorkspaceShellProps = {}) {
  const admin = __previewAdmin ?? (await requireAdmin());
  const allowedTypes = await resolveAllowedModules(admin.userId, admin.companyId);

  const allInitialWindows: InitialWindow[] = [
    {
      state: {
        id: "win-command",
        type: "command",
        title: "Command Centre",
        x: 80,
        y: 80,
        width: 760,
        height: 600,
        z: 1,
        pinned: true,
        minimised: false,
        maximised: false,
        docked: null,
        priority: "high",
        urgency: "visible",
        loading: false,
        stale: false,
        permissionDenied: false,
        error: null,
      },
      content: <CommandCentrePanel companyId={admin.companyId} embedded />,
    },
    {
      state: {
        id: "win-tasks",
        type: "tasks",
        title: "Tasks",
        x: 120,
        y: 160,
        width: 700,
        height: 520,
        z: 2,
        pinned: false,
        minimised: false,
        maximised: false,
        docked: null,
        priority: "normal",
        urgency: "queued",
        loading: false,
        stale: false,
        permissionDenied: false,
        error: null,
      },
      content: <TasksPanel companyId={admin.companyId} embedded />,
    },
    {
      state: {
        id: "win-approvals",
        type: "approvals",
        title: "Approvals",
        x: 160,
        y: 200,
        width: 760,
        height: 520,
        z: 3,
        pinned: false,
        minimised: false,
        maximised: false,
        docked: null,
        priority: "high",
        urgency: "visible",
        loading: false,
        stale: false,
        permissionDenied: false,
        error: null,
      },
      content: <ApprovalsPanel userId={admin.userId} companyId={admin.companyId} embedded />,
    },
    {
      state: {
        id: "win-ai-recs",
        type: "ai-recommendations",
        title: "AI Recommendations",
        x: 200,
        y: 240,
        width: 520,
        height: 640,
        z: 4,
        pinned: false,
        minimised: true,
        maximised: false,
        docked: "right",
        priority: "normal",
        urgency: "background",
        loading: false,
        stale: false,
        permissionDenied: false,
        error: null,
      },
      content: <AIRecommendationsPanel userId={admin.userId} companyId={admin.companyId} />,
    },
    {
      state: {
        id: "win-finance",
        type: "finance",
        title: "Finance",
        x: 240,
        y: 120,
        width: 760,
        height: 600,
        z: 5,
        pinned: false,
        minimised: true,
        maximised: false,
        docked: "bottom",
        priority: "normal",
        urgency: "background",
        loading: false,
        stale: false,
        permissionDenied: false,
        error: null,
      },
      content: <FinancePanel companyId={admin.companyId} embedded />,
    },
    {
      state: {
        id: "win-system-health",
        type: "system-health",
        title: "System Health",
        x: 280,
        y: 160,
        width: 800,
        height: 600,
        z: 6,
        pinned: false,
        minimised: true,
        maximised: false,
        docked: "right",
        priority: "high",
        urgency: "visible",
        loading: false,
        stale: false,
        permissionDenied: false,
        error: null,
      },
      content: <SystemHealthPanel companyId={admin.companyId} embedded />,
    },
  ];

  const initialWindows = allInitialWindows.filter((iw) => allowedTypes.includes(iw.state.type));
  const initialArrivals = await loadArrivals(admin.userId, admin.companyId, {
    allowedModuleTypes: allowedTypes,
    limit: 50,
  });

  return (
    <WorkspaceProvider userId={admin.userId} initialWindows={initialWindows}>
      <SpatialWorkspace
        companyId={admin.companyId}
        userId={admin.userId}
        allowedTypes={allowedTypes}
        initialArrivals={initialArrivals}
      />
    </WorkspaceProvider>
  );
}
