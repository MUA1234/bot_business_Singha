/**
 * FIN-007 — Funding requirements and investments.
 * Pure deterministic helpers. Computes a funding gap from a cash-forecast result
 * and tracks investment disposition economics. Uses exact-decimal Money only.
 */
import { Money } from "@/lib/money";
import type { ForecastResult } from "@/management/ai-manager/forecast";

export interface FundingGap {
  currency: string;
  /** Negative of the lowest forecast balance when it is below zero; otherwise zero. */
  amount: string;
  /** Date on which the shortfall occurs. */
  date: string;
  /** True when the forecast drops below zero at any point. */
  goesNegative: boolean;
}

/**
 * Derive the funding gap from a deterministic cash forecast.
 * The gap is the amount that must be raised so the lowest daily balance is zero.
 * If the forecast never goes negative, the gap is zero.
 */
export function computeFundingGap(forecast: ForecastResult): FundingGap {
  const lowest = Money.of(forecast.lowest.balance, forecast.currency);
  if (!lowest.isNegative()) {
    return {
      currency: forecast.currency,
      amount: Money.zero(forecast.currency).toString(),
      date: forecast.lowest.date,
      goesNegative: false,
    };
  }
  return {
    currency: forecast.currency,
    amount: lowest.times("-1").toString(),
    date: forecast.lowest.date,
    goesNegative: true,
  };
}

export interface InvestmentValuation {
  costBasis: string;
  currentValue: string;
  unrealizedGainOrLoss: string;
  realizedGainOrLoss: string | null;
}

/**
 * Compute the economics of an investment row.
 * Active investments compare cost_basis to current_value.
 * Disposed investments compare disposal_proceeds to cost_basis.
 */
export function computeInvestmentEconomics(row: {
  cost_basis: string | number;
  current_value: string | number | null;
  disposal_proceeds: string | number | null;
  status: string;
  currency: string;
}): InvestmentValuation {
  const currency = row.currency;
  const cost = Money.of(String(row.cost_basis), currency);

  if (row.status === "disposed") {
    const proceeds = Money.of(String(row.disposal_proceeds ?? 0), currency);
    return {
      costBasis: cost.toString(),
      currentValue: proceeds.toString(),
      unrealizedGainOrLoss: Money.zero(currency).toString(),
      realizedGainOrLoss: proceeds.minus(cost).toString(),
    };
  }

  const current = Money.of(String(row.current_value ?? 0), currency);
  return {
    costBasis: cost.toString(),
    currentValue: current.toString(),
    unrealizedGainOrLoss: current.minus(cost).toString(),
    realizedGainOrLoss: null,
  };
}

/**
 * Suggest a name for a funding requirement derived from the date of the gap.
 */
export function suggestFundingRequirementName(gapDate: string): string {
  return `Funding requirement — ${gapDate}`;
}
