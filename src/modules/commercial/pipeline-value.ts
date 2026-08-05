/**
 * Sales pipeline summary (Architecture V2 change plan §9.1). Pure and deterministic:
 * open-deal value, probability-weighted forecast, and won value. These are planning
 * estimates (ranking/forecast), not posted ledger money — the ledger records actuals
 * only when an invoice is posted.
 */
export interface Opportunity {
  amount: number;
  probability: number; // 0..100
  status: "open" | "won" | "lost";
}

export interface PipelineSummary {
  openCount: number;
  openValue: number; // sum of open amounts
  weightedValue: number; // sum of amount * probability
  wonValue: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarizePipeline(opps: Opportunity[]): PipelineSummary {
  let openCount = 0;
  let openValue = 0;
  let weightedValue = 0;
  let wonValue = 0;

  for (const o of opps) {
    const amount = Math.max(0, o.amount || 0);
    const prob = Math.min(Math.max(o.probability || 0, 0), 100) / 100;
    if (o.status === "open") {
      openCount++;
      openValue += amount;
      weightedValue += amount * prob;
    } else if (o.status === "won") {
      wonValue += amount;
    }
  }

  return { openCount, openValue: round2(openValue), weightedValue: round2(weightedValue), wonValue: round2(wonValue) };
}
