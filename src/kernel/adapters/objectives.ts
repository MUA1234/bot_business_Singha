/**
 * Objectives / KPI observation adapter (R2A).
 *
 * WRAPS the existing, tested `assessObjective` (src/management/ai-manager/objective-status.ts),
 * which compares progress against elapsed time and returns on_track / at_risk / off_track /
 * done. That judgement is not reimplemented here.
 *
 * The adapter reports what is RECORDED. `current_value` is owner-maintained; the kernel never
 * estimates, extrapolates or infers it — an objective nobody has updated is reported on the
 * numbers present, not on a guess about where it probably is.
 */
import { assessObjective, type ObjectiveStatus } from "@/management/ai-manager/objective-status";
import type { EvidenceRef } from "../types";
import {
  dayWindow, freshnessFor, identityKeyFor, priorityFor,
  type Observation, type Severity,
} from "../observation";

export const OBJECTIVES_SOURCE = "objectives.objective_at_risk";

export interface ObjectiveRow {
  id: string;
  target_value: number | string | null;
  current_value: number | string | null;
  period_start: string | null;
  period_end: string | null;
  status: string | null;
  updated_at?: string | null;
}

/** An objective in one of these states is finished and must not reappear. */
const RESOLVED = new Set(["done", "achieved", "closed", "cancelled", "abandoned"]);

const SEVERITY: Partial<Record<ObjectiveStatus, Severity>> = {
  off_track: "critical",
  at_risk: "warn",
};

export interface ObjectivesScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  objectives: ObjectiveRow[];
}

export function detectObjectiveObservations(input: ObjectivesScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const out: Observation[] = [];

  for (const o of input.objectives) {
    if (o.status && RESOLVED.has(o.status.toLowerCase())) continue;

    const target = Number(o.target_value);
    const current = Number(o.current_value ?? 0);
    // An objective with no usable target cannot be assessed. Reporting it as "off track"
    // would be inventing a judgement the data cannot support.
    if (!Number.isFinite(target) || target <= 0) continue;

    // A period that has already ended is historical; a new occurrence window would keep
    // re-raising it forever.
    if (o.period_end && Date.parse(o.period_end) < now.getTime()) continue;

    const assessment = assessObjective(
      { target, current, periodStart: o.period_start, periodEnd: o.period_end },
      now,
    );
    const severity = SEVERITY[assessment.status];
    if (!severity) continue; // on_track or done — nothing needs attention

    const freshness = freshnessFor(o.updated_at ?? o.period_start, now);

    // Bands, not the raw metric: a management queue is read across a company, and the exact
    // value of a commercially sensitive KPI is not something every manager needs in order to
    // know an objective is slipping.
    const facts = {
      objective_status: assessment.status,
      progress_band: band(assessment.progressPct),
      time_elapsed_band: band(assessment.timePct),
    };

    const evidence: EvidenceRef[] = [
      { sourceTable: "objectives", sourceId: o.id, facts, origin: "detector" },
    ];

    out.push({
      companyId,
      department: "objectives",
      observationSource: OBJECTIVES_SOURCE,
      kind: "objective_at_risk",
      subjectRef: { table: "objectives", id: o.id },
      evidence,
      evidenceAt: o.updated_at ?? o.period_start ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts,
      summary: assessment.status === "off_track" ? "Objective off track" : "Objective at risk",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId, observationSource: OBJECTIVES_SOURCE, subjectId: o.id, window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: "review",
      // Re-planning an objective is a management decision, never automatic.
      authorityClass: "manager_approval",
      correlationId,
      // The period end is a real, recorded deadline.
      businessDeadline: o.period_end ? { at: o.period_end, source: "evidence" } : null,
    });
  }

  return out;
}

function band(pct: number): string {
  if (pct >= 0.9) return "90-100%";
  if (pct >= 0.75) return "75-90%";
  if (pct >= 0.5) return "50-75%";
  if (pct >= 0.25) return "25-50%";
  return "under-25%";
}
