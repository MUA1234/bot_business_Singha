/**
 * Short-horizon cash forecast (Architecture V2 change plan §6.2 forecast engine /
 * §8.5 forecast views). Pure and deterministic: projects the cash balance forward
 * from opening cash and dated expected inflows/outflows. Decimal money throughout
 * (Constitution §8). It forecasts — it never moves money.
 */
import { Money } from "@/lib/money";

export interface CashFlowItem {
  date: string; // ISO date
  amount: string; // decimal string, > 0
}

export interface ForecastInput {
  currency: string;
  openingCash: string; // decimal string
  inflows: CashFlowItem[];
  outflows: CashFlowItem[];
  horizonDays: number;
}

export interface ForecastPoint {
  date: string;
  balance: string;
}

export interface ForecastResult {
  currency: string;
  points: ForecastPoint[];
  closingBalance: string;
  lowest: ForecastPoint; // trough — the cash-risk moment
  goesNegative: boolean;
}

const DAY = 86_400_000;

/** Project daily cash balance across the horizon. Events are applied on their date. */
export function projectCash(input: ForecastInput): ForecastResult {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const horizon = Math.max(1, Math.min(input.horizonDays, 366));

  // Net movement per day offset.
  const deltas = new Map<number, Money>();
  const add = (item: CashFlowItem, sign: 1 | -1) => {
    const t = new Date(item.date).getTime();
    if (!Number.isFinite(t)) return;
    const offset = Math.floor((t - start.getTime()) / DAY);
    if (offset < 0 || offset > horizon) return; // outside horizon
    const amt = Money.of(item.amount, input.currency).times(sign === 1 ? "1" : "-1");
    const cur = deltas.get(offset);
    deltas.set(offset, cur ? cur.plus(amt) : amt);
  };
  input.inflows.forEach((i) => add(i, 1));
  input.outflows.forEach((o) => add(o, -1));

  let balance = Money.of(input.openingCash, input.currency);
  const points: ForecastPoint[] = [];
  let lowest: ForecastPoint = { date: start.toISOString().slice(0, 10), balance: balance.toString() };
  let lowestMoney = balance;

  for (let d = 0; d <= horizon; d++) {
    const delta = deltas.get(d);
    if (delta) balance = balance.plus(delta);
    const dateStr = new Date(start.getTime() + d * DAY).toISOString().slice(0, 10);
    points.push({ date: dateStr, balance: balance.toString() });
    if (balance.compare(lowestMoney) < 0) {
      lowestMoney = balance;
      lowest = { date: dateStr, balance: balance.toString() };
    }
  }

  return {
    currency: input.currency,
    points,
    closingBalance: balance.toString(),
    lowest,
    goesNegative: lowestMoney.isNegative(),
  };
}
