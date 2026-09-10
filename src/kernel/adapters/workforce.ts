/**
 * Workforce observation adapter (R1 checkpoint 3).
 *
 * WRAPS the existing, tested `detectCapacityExceptions` (src/management/ai-manager/exceptions.ts)
 * and `evaluateAvailability` (src/modules/work/availability.ts). Neither is reimplemented.
 *
 * PEOPLE DATA IS THE MOST SENSITIVE CLASS THIS SYSTEM HANDLES. An observation about a person
 * carries their MEMBERSHIP REFERENCE and a workload band — never a name, never leave reasons,
 * never health or personal circumstance, never remuneration. WRK-006 (explainability and
 * fairness) is not built in R1, so this adapter deliberately produces a capacity signal about
 * WORK, not a judgement about a PERSON.
 */
import { detectCapacityExceptions, type CapacityLike } from "@/management/ai-manager/exceptions";
import type { EvidenceRef } from "../types";
import {
  dayWindow,
  freshnessFor,
  identityKeyFor,
  priorityFor,
  type Observation,
  type Severity,
} from "../observation";

export const WORKFORCE_SOURCE = "workforce.capacity_exception";

export interface CapacityRow extends CapacityLike {
  /** The membership the capacity snapshot belongs to. */
  membershipId: string;
  /** When the snapshot was taken. */
  capturedAt: string | null;
  /** Snapshot row id, for the evidence reference. */
  snapshotId: string;
}

export interface WorkforceScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  capacities: CapacityRow[];
}

/** `overloaded` is a real risk; `underallocated` is information, not a problem. */
const SEVERITY_BY_TYPE: Record<string, Severity> = {
  overloaded: "warn",
  underallocated: "info",
};

export function detectWorkforceObservations(input: WorkforceScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const byMembership = new Map(input.capacities.map((c) => [c.membershipId, c]));

  // The existing detector does the judging; this adapter only carries the result.
  const exceptions = detectCapacityExceptions(input.capacities);

  const out: Observation[] = [];
  for (const ex of exceptions) {
    const membershipId = ex.membershipId;
    if (!membershipId) continue;
    const row = byMembership.get(membershipId);
    if (!row) continue;

    const severity = SEVERITY_BY_TYPE[ex.type] ?? "info";
    const freshness = freshnessFor(row.capturedAt, now);

    const evidence: EvidenceRef[] = [
      {
        sourceTable: "capacity_snapshots",
        sourceId: row.snapshotId,
        // A band, not hours against a named person.
        facts: { exception_type: ex.type, utilisation_band: band(row) },
        origin: "detector",
      },
    ];

    out.push({
      companyId,
      department: "workforce",
      observationSource: WORKFORCE_SOURCE,
      kind: ex.type,
      // The SUBJECT is the membership, so the item is company-scoped and follows the
      // existing identity model rather than naming a person.
      subjectRef: { table: "memberships", id: membershipId },
      evidence,
      evidenceAt: row.capturedAt ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts: { exception_type: ex.type, utilisation_band: band(row) },
      summary: ex.type === "overloaded" ? "Workload above sustainable capacity" : "Capacity available",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId,
        observationSource: WORKFORCE_SOURCE,
        subjectId: membershipId,
        window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: ex.type === "overloaded" ? "reassign" : "review",
      // Changing who does what is a management decision, never automatic.
      authorityClass: "manager_approval",
      correlationId,
      // Capacity has no intrinsic business deadline, and inventing one is forbidden.
      businessDeadline: null,
    });
  }

  return out;
}

function band(c: CapacityLike): string {
  const pct = typeof c.utilizationPct === "number" ? c.utilizationPct : null;
  if (pct === null) return "unknown";
  if (pct >= 120) return "120%+";
  if (pct >= 100) return "100-120%";
  if (pct >= 80) return "80-100%";
  if (pct >= 50) return "50-80%";
  return "under-50%";
}
