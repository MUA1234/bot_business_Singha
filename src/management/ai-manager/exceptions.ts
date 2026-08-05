/**
 * Exception detector (Architecture V2 change plan §6.2; feeds the exception-led
 * command centre, §10). Pure and deterministic: given the current task and capacity
 * state, it surfaces what a manager must look at — overdue, blocked, escalated,
 * stale, un-estimated work, and over/under-loaded people. It decides nothing and
 * changes nothing; it only ranks attention.
 */
import { isTerminal, type TaskState } from "@/modules/work/task-lifecycle";
import type { CapacityStatus } from "@/modules/work/capacity";

export type ExceptionType =
  | "overdue"
  | "due_soon"
  | "blocked"
  | "escalated"
  | "stale_check_in"
  | "missing_estimate"
  | "overloaded"
  | "underallocated";

export type Severity = "info" | "warn" | "critical";

export interface Exception {
  type: ExceptionType;
  severity: Severity;
  message: string;
  taskId?: string;
  membershipId?: string;
}

export interface TaskLike {
  id: string;
  title: string;
  status: TaskState;
  dueDate?: string | null; // ISO date
  lastCheckInAt?: string | null; // ISO datetime
  estimateHours?: number | null;
}

const DAY = 86_400_000;
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** Task-level exceptions. `now` is injected so the function stays pure/testable. */
export function detectTaskExceptions(tasks: TaskLike[], now: Date): Exception[] {
  const out: Exception[] = [];
  const t = now.getTime();

  for (const task of tasks) {
    if (isTerminal(task.status)) continue;

    if (task.status === "escalated") {
      out.push({ type: "escalated", severity: "critical", message: `Escalated: ${task.title}`, taskId: task.id });
    }
    if (task.status === "blocked") {
      out.push({ type: "blocked", severity: "warn", message: `Blocked: ${task.title}`, taskId: task.id });
    }

    if (task.dueDate) {
      const due = new Date(task.dueDate).getTime();
      if (Number.isFinite(due)) {
        if (due < t) {
          out.push({ type: "overdue", severity: "critical", message: `Overdue: ${task.title}`, taskId: task.id });
        } else if (due - t <= 2 * DAY) {
          out.push({ type: "due_soon", severity: "warn", message: `Due soon: ${task.title}`, taskId: task.id });
        }
      }
    }

    if (task.status === "in_progress") {
      const last = task.lastCheckInAt ? new Date(task.lastCheckInAt).getTime() : null;
      if (last === null || t - last > 3 * DAY) {
        out.push({ type: "stale_check_in", severity: "warn", message: `No recent check-in: ${task.title}`, taskId: task.id });
      }
    }

    if (
      (task.status === "scheduled" || task.status === "in_progress") &&
      (task.estimateHours === null || task.estimateHours === undefined)
    ) {
      out.push({ type: "missing_estimate", severity: "warn", message: `No estimate: ${task.title}`, taskId: task.id });
    }
  }

  return sortBySeverity(out);
}

export interface CapacityLike {
  membershipId: string;
  status: CapacityStatus;
  utilizationPct: number;
}

export function detectCapacityExceptions(caps: CapacityLike[]): Exception[] {
  const out: Exception[] = [];
  for (const c of caps) {
    if (c.status === "overloaded") {
      out.push({ type: "overloaded", severity: "critical", message: `Overloaded (${c.utilizationPct}%)`, membershipId: c.membershipId });
    } else if (c.status === "underallocated") {
      out.push({ type: "underallocated", severity: "info", message: `Underallocated (${c.utilizationPct}%)`, membershipId: c.membershipId });
    }
  }
  return sortBySeverity(out);
}

/** Critical first, then warn, then info. Stable within a severity. */
export function sortBySeverity(list: Exception[]): Exception[] {
  return [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
