/**
 * Objective / KPI progress (Architecture V2 change plan §10.1). Pure and
 * deterministic: compares how far a metric has progressed against how much of its
 * time window has elapsed, and grades it on_track / at_risk / off_track / done. It
 * assesses — it changes nothing.
 */
export type ObjectiveStatus = "on_track" | "at_risk" | "off_track" | "done";

export interface ObjectiveInput {
  target: number;
  current: number;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export interface ObjectiveAssessment {
  progressPct: number; // 0..1 (current / target)
  timePct: number; // 0..1 elapsed of the window
  status: ObjectiveStatus;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function assessObjective(input: ObjectiveInput, now = new Date()): ObjectiveAssessment {
  const progressPct = input.target > 0 ? clamp01(input.current / input.target) : input.current > 0 ? 1 : 0;

  let timePct = 1;
  if (input.periodStart && input.periodEnd) {
    const s = new Date(input.periodStart).getTime();
    const e = new Date(input.periodEnd).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      timePct = clamp01((now.getTime() - s) / (e - s));
    }
  }

  let status: ObjectiveStatus;
  if (progressPct >= 1) status = "done";
  else if (progressPct >= timePct - 0.1) status = "on_track";
  else if (progressPct >= timePct - 0.25) status = "at_risk";
  else status = "off_track";

  return { progressPct, timePct, status };
}
