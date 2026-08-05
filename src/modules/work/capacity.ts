/**
 * Employee capacity calculation (Architecture V2 change plan §7.2, diagram 6).
 * Pure and deterministic. Hours are ordinary numbers (NOT money — the decimal rule
 * in Constitution §8 applies to financial values only). The AI uses this to spot
 * over/under-allocation and drive capacity-aware assignment; it never overrides it.
 */

export interface CapacityInputs {
  contractedHours: number; // weekly contracted hours
  leaveHours: number; // approved leave / absence this week
  meetingHours: number; // meetings, travel, site commitments
  recurringHours: number; // recurring responsibilities
  taskEstimateHours: number; // sum of active task estimates assigned
  contingencyPct: number; // 0..1 buffer kept free (e.g. 0.1 = 10%)
}

export type CapacityStatus = "overloaded" | "healthy" | "underallocated";

export interface CapacityResult {
  totalHours: number; // contracted minus leave
  netCapacityHours: number; // total minus meetings, recurring and contingency
  allocatedHours: number; // work committed via task estimates
  availableHours: number; // net minus allocated (may be negative = overloaded)
  utilizationPct: number; // allocated / net * 100 (0 when net is 0)
  status: CapacityStatus;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const atLeast0 = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Below this utilisation an employee is flagged underallocated. */
export const UNDERALLOCATED_BELOW_PCT = 60;

export function computeCapacity(input: CapacityInputs): CapacityResult {
  const contracted = atLeast0(input.contractedHours);
  const leave = atLeast0(input.leaveHours);
  const meetings = atLeast0(input.meetingHours);
  const recurring = atLeast0(input.recurringHours);
  const allocated = atLeast0(input.taskEstimateHours);
  const contingencyPct = Math.min(Math.max(input.contingencyPct || 0, 0), 1);

  const totalHours = atLeast0(contracted - leave);
  const contingency = totalHours * contingencyPct;
  const netCapacityHours = atLeast0(totalHours - meetings - recurring - contingency);
  const availableHours = netCapacityHours - allocated;
  const utilizationPct = netCapacityHours > 0 ? (allocated / netCapacityHours) * 100 : allocated > 0 ? Infinity : 0;

  let status: CapacityStatus;
  if (availableHours < 0) status = "overloaded";
  else if (utilizationPct < UNDERALLOCATED_BELOW_PCT) status = "underallocated";
  else status = "healthy";

  return {
    totalHours: round2(totalHours),
    netCapacityHours: round2(netCapacityHours),
    allocatedHours: round2(allocated),
    availableHours: round2(availableHours),
    utilizationPct: Number.isFinite(utilizationPct) ? round2(utilizationPct) : utilizationPct,
    status,
  };
}
