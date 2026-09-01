/**
 * The observation-source registry (R1 checkpoint 3 — KRN-002, owner decision R1-D-5).
 *
 * ONE contract, four trigger modes, cadence configurable per source and per company. The
 * existing in-process scheduler drives `scheduled` sweeps; R1 introduces no second scheduler
 * and no uncontrolled polling.
 *
 * Adding a department means adding a row here and a detector module. It must never mean
 * changing the kernel — that is the test of whether this architecture was actually achieved.
 */
import type { ObservationSourceSpec } from "../types";
import { FINANCE_SOURCE } from "./finance";
import { WORKFORCE_SOURCE } from "./workforce";
import { OPERATIONS_SOURCE } from "./operations";
import { CRM_SOURCE } from "./crm";
import { SYSTEM_SOURCE } from "./system-health";

export { detectFinanceObservations, FINANCE_SOURCE } from "./finance";
export { detectWorkforceObservations, WORKFORCE_SOURCE } from "./workforce";
export { detectOperationsObservations, OPERATIONS_SOURCE } from "./operations";
export { detectCrmObservations, CRM_SOURCE } from "./crm";
export { detectSystemHealthObservations, SYSTEM_SOURCE } from "./system-health";

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Default registrations. A row with a company id in `observation_sources` overrides the
 * cadence for that company; these are the fallback defaults.
 *
 * Cadence is chosen by how fast the absence hurts, and it is the main recurring-cost lever —
 * the same reasoning `src/lib/scheduler.ts` already applies to its jobs. None of these
 * detectors calls a model, so the cost is database work only.
 */
export const OBSERVATION_SOURCES: readonly (ObservationSourceSpec & { source: string })[] = [
  {
    source: FINANCE_SOURCE,
    department: "finance",
    kind: "receivable_overdue",
    // Money ages by the day, not the minute.
    supportsEvent: false, supportsScheduled: true, supportsManual: true, cadenceSeconds: 6 * HOUR,
  },
  {
    source: WORKFORCE_SOURCE,
    department: "workforce",
    kind: "capacity_exception",
    // Capacity snapshots are produced daily; scanning faster observes nothing new.
    supportsEvent: false, supportsScheduled: true, supportsManual: true, cadenceSeconds: 24 * HOUR,
  },
  {
    source: OPERATIONS_SOURCE,
    department: "operations",
    kind: "task_exception",
    supportsEvent: false, supportsScheduled: true, supportsManual: true, cadenceSeconds: 1 * HOUR,
  },
  {
    source: CRM_SOURCE,
    department: "crm",
    kind: "followup_due",
    // A waiting customer is the most time-sensitive signal here, and an inbound message is
    // already an event, so this source prefers the event path when one is wired.
    supportsEvent: true, supportsScheduled: true, supportsManual: true, cadenceSeconds: 15 * MINUTE,
  },
  {
    source: SYSTEM_SOURCE,
    department: "system",
    kind: "health_degraded",
    supportsEvent: false, supportsScheduled: true, supportsManual: true, cadenceSeconds: 15 * MINUTE,
  },
] as const;

export function specFor(source: string): (ObservationSourceSpec & { source: string }) | null {
  return OBSERVATION_SOURCES.find((s) => s.source === source) ?? null;
}
