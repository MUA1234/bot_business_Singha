"use client";

import { lazy, Suspense, type ComponentType } from "react";
import type { WindowContentProps, WindowTypeSpec } from "./types";
import { PageLoader } from "@/components/ui";
import { ModuleWindow } from "./windows/ModuleWindow";

// Lazy load window contents so the core shell stays lightweight.
const CommandCentreWindow = lazy(() => import("./windows/CommandCentreWindow"));
const TasksWorkspaceWindow = lazy(() => import("./windows/TasksWorkspaceWindow"));
const ApprovalsWindow = lazy(() => import("./windows/ApprovalsWindow"));
const AIRecommendationsWindow = lazy(() => import("./windows/AIRecommendationsWindow"));

export const WINDOW_SPECS: WindowTypeSpec[] = [
  {
    type: "command",
    label: "Command Centre",
    icon: "gauge",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 720,
    defaultHeight: 560,
    defaultPriority: "high",
  },
  {
    type: "tasks",
    label: "Tasks",
    icon: "list-todo",
    requiredCapabilities: [],
    singleton: false,
    defaultWidth: 640,
    defaultHeight: 440,
    defaultPriority: "normal",
  },
  {
    type: "approvals",
    label: "Approvals",
    icon: "check-circle",
    requiredCapabilities: [],
    singleton: false,
    defaultWidth: 720,
    defaultHeight: 480,
    defaultPriority: "high",
  },
  {
    type: "ai-recommendations",
    label: "AI Recommendations",
    icon: "sparkles",
    requiredCapabilities: [],
    singleton: false,
    defaultWidth: 480,
    defaultHeight: 640,
    defaultPriority: "normal",
  },
  {
    type: "finance",
    label: "Finance",
    icon: "wallet",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 760,
    defaultHeight: 600,
    defaultPriority: "normal",
  },
  {
    type: "staff",
    label: "Staff",
    icon: "users",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 720,
    defaultHeight: 520,
    defaultPriority: "normal",
  },
  {
    type: "projects",
    label: "Projects",
    icon: "rocket",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 900,
    defaultHeight: 560,
    defaultPriority: "normal",
  },
  {
    type: "customers",
    label: "Customers",
    icon: "user-round",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 900,
    defaultHeight: 600,
    defaultPriority: "normal",
  },
  {
    type: "vehicles",
    label: "Vehicles",
    icon: "car",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 720,
    defaultHeight: 520,
    defaultPriority: "normal",
  },
  {
    type: "purchase-orders",
    label: "Purchase Orders",
    icon: "shopping-cart",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 900,
    defaultHeight: 560,
    defaultPriority: "normal",
  },
  {
    type: "risks",
    label: "Risks",
    icon: "shield",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 760,
    defaultHeight: 560,
    defaultPriority: "normal",
  },
  {
    type: "system-health",
    label: "System Health",
    icon: "gauge",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 800,
    defaultHeight: 600,
    defaultPriority: "high",
  },
];

const RENDERERS: Record<string, ComponentType<WindowContentProps>> = {
  command: CommandCentreWindow,
  tasks: TasksWorkspaceWindow,
  approvals: ApprovalsWindow,
  "ai-recommendations": AIRecommendationsWindow,
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

export function getWindowSpec(type: string): WindowTypeSpec | undefined {
  return WINDOW_SPECS.find((s) => s.type === type);
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
