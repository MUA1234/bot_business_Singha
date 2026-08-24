import { requireAdmin } from "@/lib/auth";
import { WorkspaceProvider, type InitialWindow } from "@/components/spatial/WorkspaceProvider";
import { SpatialWorkspace } from "@/components/spatial/SpatialWorkspace";
import { CommandCentrePanel } from "@/components/spatial/panels/CommandCentrePanel";
import { TasksPanel } from "@/components/spatial/panels/TasksPanel";
import { ApprovalsPanel } from "@/components/spatial/panels/ApprovalsPanel";
import { AIRecommendationsPanel } from "@/components/spatial/panels/AIRecommendationsPanel";

/**
 * Server-side shell for the spatial workspace. It pre-renders the initial windows as
 * server components and passes them to the client `WorkspaceProvider`. The client
 * manager then handles drag, focus, minimise, maximise and docking.
 */
export async function SpatialWorkspaceShell() {
  const admin = await requireAdmin();

  const initialWindows: InitialWindow[] = [
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
  ];

  return (
    <WorkspaceProvider userId={admin.userId} initialWindows={initialWindows}>
      <SpatialWorkspace companyId={admin.companyId} userId={admin.userId} />
    </WorkspaceProvider>
  );
}
