"use client";

import { lazy, Suspense, type ComponentType } from "react";
import type { WindowContentProps } from "./types";
import { PageLoader } from "@/components/ui";
import { ModuleWindow } from "./windows/ModuleWindow";
import { WINDOW_SPECS, getWindowSpec } from "./windowSpecs";

export { WINDOW_SPECS, getWindowSpec } from "./windowSpecs";

// Lazy load window contents so the core shell stays lightweight.
const CommandCentreWindow = lazy(() => import("./windows/CommandCentreWindow"));
const TasksWorkspaceWindow = lazy(() => import("./windows/TasksWorkspaceWindow"));
const ApprovalsWindow = lazy(() => import("./windows/ApprovalsWindow"));
const AIRecommendationsWindow = lazy(() => import("./windows/AIRecommendationsWindow"));
const ManagementQueueWindow = lazy(() => import("./windows/ManagementQueueWindow"));

const RENDERERS: Record<string, ComponentType<WindowContentProps>> = {
  command: CommandCentreWindow,
  tasks: TasksWorkspaceWindow,
  approvals: ApprovalsWindow,
  "ai-recommendations": AIRecommendationsWindow,
  "management-queue": ManagementQueueWindow,
  finance: ModuleWindow,
  staff: ModuleWindow,
  projects: ModuleWindow,
  customers: ModuleWindow,
  vehicles: ModuleWindow,
  "purchase-orders": ModuleWindow,
  risks: ModuleWindow,
  "system-health": ModuleWindow,
};

export function getWindowRenderer(type: string): ComponentType<WindowContentProps> | null {
  return RENDERERS[type] ?? null;
}

export function WindowRenderer(props: WindowContentProps) {
  const Renderer = getWindowRenderer(props.type);
  if (!Renderer) return null;
  return (
    <Suspense fallback={<PageLoader />}>
      <Renderer {...props} />
    </Suspense>
  );
}
