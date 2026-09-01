/**
 * Window registry specification. Pure data — no React imports — so it can be
 * read by both server components/actions and client components.
 */
import type { WindowTypeSpec } from "./types";

export const WINDOW_SPECS: WindowTypeSpec[] = [
  {
    // R1 checkpoint 5. ONE registry entry: the management queue reuses the existing
    // window shell, chrome, docking, priority and fallbacks rather than a new UI system.
    type: "management-queue",
    label: "Management Queue",
    icon: "inbox",
    requiredCapabilities: [],
    singleton: true,
    defaultWidth: 780,
    defaultHeight: 620,
    defaultPriority: "critical",
  },
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
    requiredCapabilities: ["operations.task.manage"],
    singleton: false,
    defaultWidth: 640,
    defaultHeight: 440,
    defaultPriority: "normal",
  },
  {
    type: "approvals",
    label: "Approvals",
    icon: "check-circle",
    requiredCapabilities: ["finance.journal.post"],
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
    requiredCapabilities: ["finance.journal.post"],
    singleton: true,
    defaultWidth: 760,
    defaultHeight: 600,
    defaultPriority: "normal",
  },
  {
    type: "staff",
    label: "Staff",
    icon: "users",
    requiredCapabilities: ["hr.staff.manage"],
    singleton: true,
    defaultWidth: 720,
    defaultHeight: 520,
    defaultPriority: "normal",
  },
  {
    type: "projects",
    label: "Projects",
    icon: "rocket",
    requiredCapabilities: ["operations.project.manage"],
    singleton: true,
    defaultWidth: 900,
    defaultHeight: 560,
    defaultPriority: "normal",
  },
  {
    type: "customers",
    label: "Customers",
    icon: "user-round",
    requiredCapabilities: ["sales.quotation.manage"],
    singleton: true,
    defaultWidth: 900,
    defaultHeight: 600,
    defaultPriority: "normal",
  },
  {
    type: "vehicles",
    label: "Vehicles",
    icon: "car",
    requiredCapabilities: ["operations.fleet.manage"],
    singleton: true,
    defaultWidth: 720,
    defaultHeight: 520,
    defaultPriority: "normal",
  },
  {
    type: "purchase-orders",
    label: "Purchase Orders",
    icon: "shopping-cart",
    requiredCapabilities: ["procurement.po.approve"],
    singleton: true,
    defaultWidth: 900,
    defaultHeight: 560,
    defaultPriority: "normal",
  },
  {
    type: "risks",
    label: "Risks",
    icon: "shield",
    requiredCapabilities: ["legal.risk.manage"],
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

export function getWindowSpec(type: string): WindowTypeSpec | undefined {
  return WINDOW_SPECS.find((s) => s.type === type);
}

export function getRequiredCapabilities(type: string): string[] {
  return getWindowSpec(type)?.requiredCapabilities ?? [];
}
