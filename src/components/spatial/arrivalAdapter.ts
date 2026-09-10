/**
 * Pure adapter that turns real production rows (tasks, notifications) into the
 * SpatialArrival shape used by the peripheral rail. No polling, no simulation,
 * no invented records — just deterministic mapping and deduplication.
 */

import { scorePriority } from "@/management/ai-manager/priority";
import { isTerminal, type TaskState } from "@/modules/work/task-lifecycle";
import type { SpatialArrival, TaskArrival, AlertArrival, SpatialPriority } from "./types";

/** Raw task row as returned by Supabase. */
export interface ArrivalTaskRow {
  id: string;
  title: string;
  status: TaskState;
  due_date: string | null;
  priority: number | null;
  created_at: string;
}

/** Raw notification row as returned by Supabase. */
export interface ArrivalNotifRow {
  id: string;
  title: string;
  body: string | null;
  type: string;
  created_at: string;
}

function scoreToPriority(score: number): SpatialPriority {
  if (score >= 45) return "critical";
  if (score >= 25) return "high";
  if (score >= 10) return "normal";
  return "low";
}

const PRIORITY_RANK: Record<SpatialPriority, number> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
};

export function taskToArrival(task: ArrivalTaskRow, now = new Date()): TaskArrival {
  const score = scorePriority(
    { status: task.status, dueDate: task.due_date, basePriority: task.priority },
    now,
  );
  return {
    id: `task:${task.id}`,
    kind: "task",
    title: task.title,
    priority: scoreToPriority(score),
    timestamp: task.created_at,
    moduleType: "tasks",
    recordId: task.id,
    due: task.due_date,
  };
}

export function notificationToArrival(notif: ArrivalNotifRow): AlertArrival {
  // Notifications currently carry no explicit priority. Derive a modest default
  // and bump critical-sounding types so they still surface in the rail.
  const criticalTypes = new Set(["security_alert", "approval_urgent", "escalation"]);
  const priority: SpatialPriority = criticalTypes.has(notif.type) ? "high" : "normal";
  return {
    id: `alert:${notif.id}`,
    kind: "alert",
    title: notif.title,
    message: notif.body ?? "",
    priority,
    timestamp: notif.created_at,
    moduleType: "command",
  };
}

/**
 * Merge task and alert arrivals, deduplicate by id, filter to authorised module
 * types, and rank by priority then recency.
 */
export function mergeArrivals(
  tasks: ArrivalTaskRow[],
  notifications: ArrivalNotifRow[],
  options: { allowedModuleTypes?: string[]; limit?: number; now?: Date } = {},
): SpatialArrival[] {
  const { allowedModuleTypes, limit = 50, now = new Date() } = options;

  const all: SpatialArrival[] = [
    ...tasks.filter((t) => !isTerminal(t.status)).map((t) => taskToArrival(t, now)),
    ...notifications.map((n) => notificationToArrival(n)),
  ];

  const seen = new Set<string>();
  const deduped: SpatialArrival[] = [];
  for (const a of all) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    if (allowedModuleTypes && !allowedModuleTypes.includes(a.moduleType)) continue;
    deduped.push(a);
  }

  deduped.sort((a, b) => {
    const rankDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (rankDiff !== 0) return rankDiff;
    return b.timestamp.localeCompare(a.timestamp);
  });

  return deduped.slice(0, limit);
}
