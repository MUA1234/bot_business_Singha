/**
 * Detailed employee capacity (NEXT_PHASE_DEVELOPER_BRIEF §WP3 "Capacity model").
 * Pure and deterministic — every number is reproducible from the underlying records,
 * never an unexplained AI score (Brief acceptance criterion). Hours are ordinary
 * numbers (the decimal rule is for money only).
 *
 * Net available = contracted − leave − holidays − reserved, then compared to the
 * remaining effort on the person's open (non-terminal) tasks.
 */
import type { TaskState } from "@/modules/work/task-lifecycle";

export interface CapacityTask {
  status: TaskState;
  estimateHours: number | null;
  actualHours: number | null;
  remainingHours: number | null; // if null, derived from estimate − actual (≥0)
  dueDate: string | null; // ISO date
}

export interface CapacityDetailInput {
  contractedWeeklyHours: number;
  approvedLeaveHours: number;
  holidayHours: number;
  reservedHours: number; // meetings / recurring / operational reserve
  tasks: CapacityTask[];
  today?: string; // ISO date (defaults to now) — for overdue detection
  overloadThresholdPct?: number; // default 100
  underThresholdPct?: number; // default 60
}

export type CapacityStatus = "overloaded" | "healthy" | "underallocated";

export interface CapacityDetail {
  netAvailableHours: number; // contracted − leave − holidays − reserved
  plannedHours: number; // sum of estimates on open tasks
  actualHours: number; // sum of actual hours logged on open tasks
  remainingHours: number; // sum of remaining effort on open tasks
  freeHours: number; // net − remaining (may be negative)
  openTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  utilizationPct: number; // remaining / net * 100
  status: CapacityStatus;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pos = (n: number | null | undefined) => (Number.isFinite(n as number) && (n as number) > 0 ? (n as number) : 0);

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(["completed", "cancelled"]);

/** Remaining effort for one task: explicit remaining, else estimate − actual (≥0). */
export function taskRemaining(t: CapacityTask): number {
  if (t.remainingHours != null && Number.isFinite(t.remainingHours)) return pos(t.remainingHours);
  return pos(pos(t.estimateHours) - pos(t.actualHours));
}

export function computeCapacityDetail(input: CapacityDetailInput): CapacityDetail {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const overloadPct = input.overloadThresholdPct ?? 100;
  const underPct = input.underThresholdPct ?? 60;

  const net = pos(pos(input.contractedWeeklyHours) - pos(input.approvedLeaveHours) - pos(input.holidayHours) - pos(input.reservedHours));

  const open = input.tasks.filter((t) => !TERMINAL.has(t.status));
  let planned = 0,
    actual = 0,
    remaining = 0,
    blocked = 0,
    overdue = 0;
  for (const t of open) {
    planned += pos(t.estimateHours);
    actual += pos(t.actualHours);
    remaining += taskRemaining(t);
    if (t.status === "blocked" || t.status === "escalated") blocked++;
    if (t.dueDate && t.dueDate < today) overdue++;
  }

  const free = net - remaining;
  const utilizationPct = net > 0 ? (remaining / net) * 100 : remaining > 0 ? Infinity : 0;

  let status: CapacityStatus;
  if (utilizationPct > overloadPct || free < 0) status = "overloaded";
  else if (utilizationPct < underPct) status = "underallocated";
  else status = "healthy";

  return {
    netAvailableHours: r2(net),
    plannedHours: r2(planned),
    actualHours: r2(actual),
    remainingHours: r2(remaining),
    freeHours: r2(free),
    openTasks: open.length,
    blockedTasks: blocked,
    overdueTasks: overdue,
    utilizationPct: Number.isFinite(utilizationPct) ? r2(utilizationPct) : utilizationPct,
    status,
  };
}
