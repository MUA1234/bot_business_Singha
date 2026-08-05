/**
 * Receivables / payables ageing (Architecture V2 change plan §8.3). Pure and
 * deterministic. All amounts are fixed-precision decimal strings via Money — never
 * JS floats (Constitution §8). Buckets an outstanding balance by how overdue it is.
 */
import { Money } from "@/lib/money";

export type AgingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

export interface AgingItem {
  dueDate: string | null; // ISO date; null ⇒ treated as current
  outstanding: string; // decimal string, > 0
}

export interface AgingResult {
  currency: string;
  buckets: Record<AgingBucket, string>;
  total: string;
  overdue: string; // everything except "current"
}

const DAY = 86_400_000;

/** Which bucket an item falls in, given the reporting date. */
export function bucketFor(dueDate: string | null, asOf: Date): AgingBucket {
  if (!dueDate) return "current";
  const due = new Date(dueDate).getTime();
  if (!Number.isFinite(due) || due >= asOf.getTime()) return "current";
  const days = Math.floor((asOf.getTime() - due) / DAY);
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

/** Age a list of same-currency outstanding items as of a date. */
export function ageItems(items: AgingItem[], currency: string, asOf: Date): AgingResult {
  const acc: Record<AgingBucket, Money> = {
    current: Money.zero(currency),
    d1_30: Money.zero(currency),
    d31_60: Money.zero(currency),
    d61_90: Money.zero(currency),
    d90_plus: Money.zero(currency),
  };

  for (const it of items) {
    const amt = Money.of(it.outstanding, currency);
    if (!amt.isPositive()) continue; // ignore zero/negative (settled) balances
    const b = bucketFor(it.dueDate, asOf);
    acc[b] = acc[b].plus(amt);
  }

  let total = Money.zero(currency);
  let overdue = Money.zero(currency);
  for (const key of Object.keys(acc) as AgingBucket[]) {
    total = total.plus(acc[key]);
    if (key !== "current") overdue = overdue.plus(acc[key]);
  }

  return {
    currency,
    buckets: {
      current: acc.current.toString(),
      d1_30: acc.d1_30.toString(),
      d31_60: acc.d31_60.toString(),
      d61_90: acc.d61_90.toString(),
      d90_plus: acc.d90_plus.toString(),
    },
    total: total.toString(),
    overdue: overdue.toString(),
  };
}
