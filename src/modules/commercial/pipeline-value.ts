/**
 * Sales pipeline summary (Architecture V2 change plan §9.1). Pure and deterministic:
 * open-deal value, probability-weighted forecast, and won value. These are planning
 * estimates (ranking/forecast), not posted ledger money — but they are still MONEY, so
 * the sums are computed in Decimal and returned as canonical decimal strings (a float
 * sum drifts once amounts are large or fractional; Guide invariant #11).
 */
import Decimal from "decimal.js";

export interface Opportunity {
  /** Money amount as a canonical decimal string (DB numeric) — JS number accepted for legacy callers. */
  amount: string | number;
  probability: number; // 0..100 (dimensionless)
  status: "open" | "won" | "lost";
}

export interface PipelineSummary {
  openCount: number;
  /** Canonical decimal strings, 2dp. */
  openValue: string;
  weightedValue: string;
  wonValue: string;
}

function amt(value: string | number): Decimal {
  const d = new Decimal(typeof value === "number" ? String(value) : value || "0");
  return d.isFinite() && d.greaterThan(0) ? d : new Decimal(0);
}

export function summarizePipeline(opps: Opportunity[]): PipelineSummary {
  let openCount = 0;
  let openValue = new Decimal(0);
  let weightedValue = new Decimal(0);
  let wonValue = new Decimal(0);

  for (const o of opps) {
    const amount = amt(o.amount);
    const prob = new Decimal(Math.min(Math.max(o.probability || 0, 0), 100)).div(100);
    if (o.status === "open") {
      openCount++;
      openValue = openValue.plus(amount);
      weightedValue = weightedValue.plus(amount.times(prob));
    } else if (o.status === "won") {
      wonValue = wonValue.plus(amount);
    }
  }

  return {
    openCount,
    openValue: openValue.toFixed(2),
    weightedValue: weightedValue.toFixed(2),
    wonValue: wonValue.toFixed(2),
  };
}
