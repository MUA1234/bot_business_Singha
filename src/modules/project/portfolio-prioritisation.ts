/**
 * PRJ-005 — Portfolio prioritisation.
 *
 * Pure, deterministic ranking across projects by value, risk, capacity and dependency.
 * The formula is transparent and inspectable: each project is ranked on every axis,
 * then a weighted Borda-style score combines the ranks. Weights are constants so the
 * ranking is reproducible and can be argued with.
 */
import { riskExposureScore, type ProjectRiskInput } from "@/modules/project/risks";

export type RiskAxisInput = Pick<ProjectRiskInput, "impact" | "likelihood">;

export interface ProjectPrioritisationInput {
  projectId: string;
  name: string;
  // Value axis: best expected value across the project's scenarios.
  valueTotal: string; // decimal money string in project currency
  // Risk axis: open project risks.
  openRisks: RiskAxisInput[];
  // Capacity axis: count of overloaded people assigned to the project.
  overloadedPeople: number;
  // Dependency axis: count of overdue / blocked tasks.
  overdueOrBlockedTasks: number;
}

export interface ProjectPriority {
  projectId: string;
  name: string;
  valueRank: number; // 1 = highest value
  riskRank: number; // 1 = lowest risk
  capacityRank: number; // 1 = lowest pressure
  dependencyRank: number; // 1 = fewest overdue/blocked
  score: number; // lower is better
}

/** Default weights — higher weight means the axis matters more. */
export const PRIORITY_WEIGHTS = {
  value: 4,
  risk: 3,
  capacity: 2,
  dependency: 1,
} as const;

function rankDescending(values: { id: string; value: number }[]): Map<string, number> {
  const sorted = [...values].sort((a, b) => b.value - a.value);
  const result = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    // Tie handling: same rank for equal values, then next rank skips accordingly.
    if (i > 0 && sorted[i]!.value === sorted[i - 1]!.value) {
      result.set(sorted[i]!.id, result.get(sorted[i - 1]!.id)!);
    } else {
      result.set(sorted[i]!.id, i + 1);
    }
  }
  return result;
}

function rankAscending(values: { id: string; value: number }[]): Map<string, number> {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const result = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i]!.value === sorted[i - 1]!.value) {
      result.set(sorted[i]!.id, result.get(sorted[i - 1]!.id)!);
    } else {
      result.set(sorted[i]!.id, i + 1);
    }
  }
  return result;
}

function safeNumber(v: number | null | undefined): number {
  return Number.isFinite(v as number) ? (v as number) : 0;
}

/** Aggregate risk exposure for a project (worst open risk). */
export function projectRiskExposure(openRisks: RiskAxisInput[]): number {
  if (openRisks.length === 0) return 0;
  return Math.max(...openRisks.map((r) => riskExposureScore({ ...r, status: "open" })));
}

/** Parse a decimal money string; malformed or non-positive values become 0. */
function moneyValue(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Rank projects by priority. Returns an array sorted best-first (lowest score first).
 *
 * - Value: higher expected total is better.
 * - Risk: lower maximum exposure is better.
 * - Capacity: fewer overloaded assigned people is better.
 * - Dependency: fewer overdue/blocked tasks is better.
 */
export function rankProjectsByPriority(
  projects: ProjectPrioritisationInput[],
  weights: Record<keyof typeof PRIORITY_WEIGHTS, number> = PRIORITY_WEIGHTS,
): ProjectPriority[] {
  if (projects.length === 0) return [];

  const valueRanks = rankDescending(projects.map((p) => ({ id: p.projectId, value: moneyValue(p.valueTotal) })));
  const riskRanks = rankAscending(projects.map((p) => ({ id: p.projectId, value: projectRiskExposure(p.openRisks) })));
  const capacityRanks = rankAscending(projects.map((p) => ({ id: p.projectId, value: safeNumber(p.overloadedPeople) })));
  const dependencyRanks = rankAscending(projects.map((p) => ({ id: p.projectId, value: safeNumber(p.overdueOrBlockedTasks) })));

  const scored = projects.map((p) => {
    const valueRank = valueRanks.get(p.projectId) ?? projects.length;
    const riskRank = riskRanks.get(p.projectId) ?? projects.length;
    const capacityRank = capacityRanks.get(p.projectId) ?? projects.length;
    const dependencyRank = dependencyRanks.get(p.projectId) ?? projects.length;
    const score =
      weights.value * valueRank +
      weights.risk * riskRank +
      weights.capacity * capacityRank +
      weights.dependency * dependencyRank;
    return {
      projectId: p.projectId,
      name: p.name,
      valueRank,
      riskRank,
      capacityRank,
      dependencyRank,
      score,
    };
  });

  return scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
}
