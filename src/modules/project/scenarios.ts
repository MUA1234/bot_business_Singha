/**
 * PRJ-004 — Project scenario comparison helpers.
 *
 * Pure deterministic functions that compare scenario outcomes and select a preferred
 * option given a simple decision rule: choose the scenario with the best expected
 * total, subject to a worst-case floor.
 */

import { Money } from "@/lib/money";

export interface ProjectScenarioInput {
  id: string;
  title: string;
  bestCaseTotal: string;
  expectedTotal: string;
  worstCaseTotal: string;
  currency: string;
  chosen?: boolean;
}

export interface ScenarioComparisonResult {
  preferredId: string | null;
  reason: string;
}

/**
 * Select the preferred scenario using a lexicographic rule:
 *  1. Highest expected total.
 *  2. If tied, highest best-case total.
 *  3. If still tied, highest worst-case total.
 *
 * The result is advisory; a human decides which scenario is chosen.
 */
export function compareScenarios(scenarios: ProjectScenarioInput[]): ScenarioComparisonResult {
  if (scenarios.length === 0) return { preferredId: null, reason: "no scenarios to compare" };

  const sorted = [...scenarios].sort((a, b) => {
    const currency = a.currency || b.currency;
    const expectedA = Money.of(a.expectedTotal, currency);
    const expectedB = Money.of(b.expectedTotal, currency);
    const expectedCmp = expectedB.amount.comparedTo(expectedA.amount);
    if (expectedCmp !== 0) return expectedCmp;

    const bestA = Money.of(a.bestCaseTotal, currency);
    const bestB = Money.of(b.bestCaseTotal, currency);
    const bestCmp = bestB.amount.comparedTo(bestA.amount);
    if (bestCmp !== 0) return bestCmp;

    const worstA = Money.of(a.worstCaseTotal, currency);
    const worstB = Money.of(b.worstCaseTotal, currency);
    return worstB.amount.comparedTo(worstA.amount);
  });

  const winner = sorted[0]!;
  return {
    preferredId: winner.id,
    reason: `highest expected total (${winner.expectedTotal} ${winner.currency})`,
  };
}

/**
 * True if any scenario has a worst case below the given floor.
 * Floor is a decimal string in the scenario currency.
 */
export function anyScenarioBelowFloor(scenarios: ProjectScenarioInput[], floor: string): boolean {
  if (scenarios.length === 0) return false;
  const currency = scenarios[0]!.currency;
  const floorMoney = Money.of(floor, currency);
  return scenarios.some((s) => Money.of(s.worstCaseTotal, currency).amount.lt(floorMoney.amount));
}
