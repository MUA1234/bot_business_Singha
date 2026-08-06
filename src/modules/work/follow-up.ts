/**
 * Task follow-up & escalation scheduler (NEXT_PHASE_DEVELOPER_BRIEF §WP3.8 "the system
 * follows up at configurable intervals" + §WP4.7 escalation template). Pure and
 * deterministic — decides WHETHER a follow-up is due for a task and WHICH approved
 * internal template to send. The caller resolves recipients and enqueues the message
 * through the outbox; nothing here sends.
 */
import type { TaskState } from "@/modules/work/task-lifecycle";
import type { InternalTemplateId } from "@/lib/whatsapp-templates";

export interface FollowUpConfig {
  /** Hours of silence before nudging an outstanding step. */
  reminderIntervalHours: number;
  /** Days overdue before escalating to a manager. */
  escalationAfterDays: number;
}

export const DEFAULT_FOLLOW_UP: FollowUpConfig = {
  reminderIntervalHours: 24,
  escalationAfterDays: 3,
};

export interface FollowUpTask {
  status: TaskState;
  dueDate: string | null; // ISO date
  lastActivityAt: string | null; // ISO timestamp of last check-in/update
  lastReminderAt: string | null; // ISO timestamp of the last follow-up sent
}

export type FollowUpAction = Extract<
  InternalTemplateId,
  "estimate_request" | "overdue_reminder" | "verification_request" | "escalation"
>;

export interface FollowUpResult {
  due: boolean;
  action: FollowUpAction | null;
  reason: string;
}

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(["completed", "cancelled"]);

const hoursBetween = (a: number, b: number) => Math.abs(a - b) / 3_600_000;
const daysOverdue = (dueIso: string, nowMs: number) => (nowMs - new Date(dueIso).getTime()) / 86_400_000;

const none = (reason: string): FollowUpResult => ({ due: false, action: null, reason });

/** Has enough quiet time passed since the last activity AND last reminder? */
function quietLongEnough(task: FollowUpTask, nowMs: number, cfg: FollowUpConfig): boolean {
  const ref = task.lastReminderAt ?? task.lastActivityAt;
  if (!ref) return true; // never touched → due
  return hoursBetween(nowMs, new Date(ref).getTime()) >= cfg.reminderIntervalHours;
}

export function evaluateFollowUp(
  task: FollowUpTask,
  cfg: FollowUpConfig = DEFAULT_FOLLOW_UP,
  now: Date = new Date(),
): FollowUpResult {
  if (TERMINAL.has(task.status)) return none("task is terminal");
  const nowMs = now.getTime();

  // Escalate first: significantly overdue, or stuck blocked/escalated past the window.
  const overdue = task.dueDate ? daysOverdue(task.dueDate, nowMs) : 0;
  if ((overdue >= cfg.escalationAfterDays || task.status === "escalated") && quietLongEnough(task, nowMs, cfg)) {
    return { due: true, action: "escalation", reason: `overdue ${Math.floor(overdue)}d / escalated — notify manager` };
  }

  if (!quietLongEnough(task, nowMs, cfg)) return none("within the reminder interval");

  switch (task.status) {
    case "awaiting_estimate":
      return { due: true, action: "estimate_request", reason: "estimate still outstanding" };
    case "scheduled":
    case "in_progress":
    case "blocked":
    case "overdue":
      if (overdue > 0) return { due: true, action: "overdue_reminder", reason: "task is overdue" };
      return none("in progress and not yet overdue");
    case "awaiting_evidence":
    case "verification":
      return { due: true, action: "verification_request", reason: "awaiting verification" };
    default:
      return none(`no follow-up for state ${task.status}`);
  }
}
