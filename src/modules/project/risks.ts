/**
 * PRJ-004 — Per-project risk register helpers.
 *
 * Pure deterministic functions for scoring and classifying project risks.
 */

export type ProjectRiskImpact = "low" | "medium" | "high" | "critical";
export type ProjectRiskLikelihood = "low" | "medium" | "high" | "critical";
export type ProjectRiskStatus = "open" | "mitigated" | "accepted" | "closed";

export interface ProjectRiskInput {
  impact: ProjectRiskImpact;
  likelihood: ProjectRiskLikelihood;
  status: ProjectRiskStatus;
}

const SCORE: Record<ProjectRiskImpact | ProjectRiskLikelihood, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Exposure score = impact × likelihood, 1–16. */
export function riskExposureScore(input: ProjectRiskInput): number {
  return SCORE[input.impact] * SCORE[input.likelihood];
}

export type ExposureLevel = "low" | "medium" | "high" | "severe";

export function exposureLevel(score: number): ExposureLevel {
  if (score <= 2) return "low";
  if (score <= 6) return "medium";
  if (score <= 12) return "high";
  return "severe";
}

export function riskExposureLevel(input: ProjectRiskInput): ExposureLevel {
  return exposureLevel(riskExposureScore(input));
}

export function riskNeedsReview(reviewDate: string | null | undefined): boolean {
  if (!reviewDate) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const review = new Date(reviewDate);
  review.setUTCHours(0, 0, 0, 0);
  return review <= today;
}
