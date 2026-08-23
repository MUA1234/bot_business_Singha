/**
 * Leave and workload-aware availability (SCH-003). Pure and deterministic.
 *
 * Decides whether a person is available for a follow-up or assignment on a given
 * date, and ranks candidates by current workload so the system does not chase
 * someone who is on leave or pile more work onto the most overloaded assignee.
 */
import { computeCapacity, type CapacityResult } from "@/modules/work/capacity";
import { calendarDays, type DateRange } from "@/modules/workforce/leave";

export interface AvailabilityInputs {
  profileId: string;
  approvedLeave: DateRange[];
  capacity: CapacityResult;
}

export interface AvailabilityResult {
  profileId: string;
  available: boolean;
  onLeave: boolean;
  availableHours: number;
  status: CapacityResult["status"];
}

/** Shape of a generic approved leave row used by {@link buildAvailabilityInputs}. */
export interface AvailabilityLeaveRecord {
  start: string;
  end: string;
}

/** Shape of a generic employee record used by {@link buildAvailabilityInputs}. */
export interface AvailabilityEmployeeRecord {
  contracted_weekly_hours?: number | string | null;
  reserved_weekly_hours?: number | string | null;
}

/** Shape of a generic task assignment used by {@link buildAvailabilityInputs}. */
export interface AvailabilityAssignmentRecord {
  task_status: string;
  estimate_hours?: number | string | null;
}

const DAY = 86_400_000;

/** Is a single ISO date inside any of the approved leave ranges (inclusive)? */
export function isOnLeave(dateIso: string, approvedLeave: DateRange[]): boolean {
  const t = new Date(dateIso).getTime();
  if (!Number.isFinite(t)) return false;
  return approvedLeave.some((r) => {
    const s = new Date(r.start).getTime();
    const e = new Date(r.end).getTime();
    return Number.isFinite(s) && Number.isFinite(e) && s <= t && t <= e;
  });
}

/** Compute availability for one person on a given date. */
export function evaluateAvailability(
  inputs: AvailabilityInputs,
  dateIso: string = new Date().toISOString().slice(0, 10),
): AvailabilityResult {
  const onLeave = isOnLeave(dateIso, inputs.approvedLeave);
  return {
    profileId: inputs.profileId,
    available: !onLeave,
    onLeave,
    availableHours: inputs.capacity.availableHours,
    status: inputs.capacity.status,
  };
}

/** Sort candidates so the most available (not on leave, most free hours) comes first. */
export function rankAvailableCandidates(results: AvailabilityResult[]): AvailabilityResult[] {
  return [...results].sort((a, b) => {
    if (a.available && !b.available) return -1;
    if (!a.available && b.available) return 1;
    return b.availableHours - a.availableHours;
  });
}

/** Pick the best available candidate, or null if nobody is available. */
export function selectBestAvailable(candidates: AvailabilityResult[]): AvailabilityResult | null {
  return rankAvailableCandidates(candidates).find((c) => c.available) ?? null;
}

const pos = (n: number | string | null | undefined) => {
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v as number) && (v as number) > 0 ? (v as number) : 0;
};

const LEAVE_HOURS_PER_DAY = 8;

/**
 * Build availability inputs from database rows.
 *
 * - Approved leave days are converted to hours at 8 h/day.
 * - Workload is the sum of assignment-level estimates on non-terminal tasks.
 * - Recurring/operational load is taken from `reserved_weekly_hours`.
 * - A 10% contingency buffer is applied so lightly-loaded people are preferred.
 */
export function buildAvailabilityInputs(
  profileId: string,
  employee: AvailabilityEmployeeRecord | null | undefined,
  approvedLeave: AvailabilityLeaveRecord[],
  assignments: AvailabilityAssignmentRecord[],
): AvailabilityInputs {
  const leaveDays = approvedLeave.reduce((sum, r) => sum + calendarDays(r.start, r.end), 0);
  const terminal = new Set(["completed", "cancelled"]);
  const taskEstimateHours = assignments
    .filter((a) => !terminal.has(a.task_status))
    .reduce((sum, a) => sum + pos(a.estimate_hours), 0);

  const capacity = computeCapacity({
    contractedHours: pos(employee?.contracted_weekly_hours),
    leaveHours: leaveDays * LEAVE_HOURS_PER_DAY,
    meetingHours: 0,
    recurringHours: pos(employee?.reserved_weekly_hours),
    taskEstimateHours,
    contingencyPct: 0.1,
  });

  return {
    profileId,
    approvedLeave: approvedLeave.map((r) => ({ start: r.start, end: r.end })),
    capacity,
  };
}

/**
 * Advance one step along an escalation chain, but only to a member who is available
 * today. Returns the first available target after the current level, or
 * `{ targetId: null, nextLevel: chain.length, reason: "chain_exhausted" }` when no
 * available member exists.
 */
export function selectAvailableEscalationTarget(
  chain: string[],
  currentLevel: number,
  availability: Map<string, AvailabilityResult>,
): { targetId: string | null; nextLevel: number; reason: string } {
  const safeChain = chain.filter((c) => typeof c === "string" && c.length > 0);
  for (let level = Math.max(0, currentLevel) + 1; level <= safeChain.length; level++) {
    const targetId = safeChain[level - 1];
    if (!targetId) continue;
    const avail = availability.get(targetId);
    if (avail?.available) {
      return { targetId, nextLevel: level, reason: `escalation_step_${level}` };
    }
  }
  return { targetId: null, nextLevel: safeChain.length, reason: "chain_exhausted" };
}
