/**
 * Priority scorer (Architecture V2 change plan §6.2). Pure and deterministic: turns a
 * task's state, deadline and base priority into a single urgency score so the AI
 * manager and the UI can rank work consistently. Higher = more urgent. Terminal work
 * scores below everything. It ranks attention only — it never changes a task.
 */
import { isTerminal, type TaskState } from "@/modules/work/task-lifecycle";

export interface PriorityInput {
  status: TaskState;
  dueDate?: string | null; // ISO date
  basePriority?: number | null; // tasks.priority: 1 (highest) .. 5 (lowest)
}

const DAY = 86_400_000;

const STATUS_WEIGHT: Partial<Record<TaskState, number>> = {
  escalated: 40,
  overdue: 35,
  blocked: 20,
  awaiting_evidence: 12,
  verification: 12,
  in_progress: 6,
};

/** Urgency score. Terminal tasks return -1 so they always sort last. */
export function scorePriority(input: PriorityInput, now: Date): number {
  if (isTerminal(input.status)) return -1;

  let score = STATUS_WEIGHT[input.status] ?? 0;

  // Base priority: 1 → +25 … 5 → +5.
  const base = Math.min(Math.max(input.basePriority ?? 3, 1), 5);
  score += (6 - base) * 5;

  // Deadline pressure.
  if (input.dueDate) {
    const due = new Date(input.dueDate).getTime();
    if (Number.isFinite(due)) {
      const delta = due - now.getTime();
      if (delta < 0) score += 40;
      else if (delta <= 2 * DAY) score += 25;
      else if (delta <= 7 * DAY) score += 10;
    }
  }

  return score;
}

/** Sort a copy of tasks by descending urgency (stable within equal scores). */
export function sortByPriority<T extends PriorityInput>(tasks: T[], now: Date): T[] {
  return [...tasks]
    .map((t, i) => ({ t, i, s: scorePriority(t, now) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}
