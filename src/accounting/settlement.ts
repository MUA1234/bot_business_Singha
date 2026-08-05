/**
 * Settlement status of an AR/AP document (Architecture V2 change plan §8.3). Pure:
 * given a document total and how much has been settled, returns the outstanding
 * amount and status. Decimal money via Money (Constitution §8). Recording a
 * settlement is NOT executing a bank payment — it records money already moved.
 */
import { Money } from "@/lib/money";

export type SettlementStatus = "unpaid" | "part_paid" | "paid";

export function remaining(total: string, settled: string, currency: string): string {
  const rem = Money.of(total, currency).minus(Money.of(settled || "0", currency));
  return (rem.isNegative() ? Money.zero(currency) : rem).toString();
}

export function settlementStatus(total: string, settled: string, currency: string): SettlementStatus {
  const t = Money.of(total, currency).round();
  const s = Money.of(settled || "0", currency).round();
  if (s.isZero()) return "unpaid";
  if (s.compare(t) >= 0) return "paid";
  return "part_paid";
}

/** True when `amount` is a valid settlement (positive and not more than outstanding). */
export function canSettle(total: string, settled: string, amount: string, currency: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(amount.trim())) return false;
  const amt = Money.of(amount.trim(), currency);
  if (!amt.isPositive()) return false;
  const rem = Money.of(remaining(total, settled, currency), currency);
  return amt.compare(rem) <= 0;
}
