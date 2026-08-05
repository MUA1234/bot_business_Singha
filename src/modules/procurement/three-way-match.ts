/**
 * Three-way match (Architecture V2 change plan §9.2): purchase order ↔ goods receipt
 * ↔ supplier bill. Pure and deterministic. Amounts are decimal strings via Money
 * (Constitution §8). A clean match is required before a bill is approved for payment;
 * any discrepancy is an exception a human resolves.
 */
import { Money } from "@/lib/money";

export interface ThreeWayInput {
  currency: string;
  poQuantity: number;
  poAmount: string; // decimal string
  receivedQuantity: number;
  billedQuantity: number;
  billedAmount: string; // decimal string
  /** Allowed absolute quantity slack (default 0). */
  quantityTolerance?: number;
  /** Allowed price variance as a fraction, e.g. 0.02 = 2% (default 0). */
  amountTolerancePct?: number;
}

export interface ThreeWayResult {
  matched: boolean;
  issues: string[];
}

export function threeWayMatch(input: ThreeWayInput): ThreeWayResult {
  const issues: string[] = [];
  const qtyTol = Math.max(input.quantityTolerance ?? 0, 0);
  const amtTol = Math.max(input.amountTolerancePct ?? 0, 0);

  // Receipt cannot exceed the order (beyond tolerance).
  if (input.receivedQuantity > input.poQuantity + qtyTol) {
    issues.push(`over-receipt: received ${input.receivedQuantity} > ordered ${input.poQuantity}`);
  }
  // You cannot bill for more than was received (beyond tolerance).
  if (input.billedQuantity > input.receivedQuantity + qtyTol) {
    issues.push(`over-billing: billed ${input.billedQuantity} > received ${input.receivedQuantity}`);
  }
  // Under-receipt is informational (partial delivery), not a hard fail here, but the
  // bill should not exceed the received quantity — already covered above.

  // Price check: billed amount vs PO amount within tolerance.
  const po = Money.of(input.poAmount, input.currency);
  const billed = Money.of(input.billedAmount, input.currency);
  const allowedOver = po.times(String(amtTol));
  const ceiling = po.plus(allowedOver);
  if (billed.greaterThan(ceiling)) {
    issues.push(`price variance: billed ${billed.toString()} > PO ${po.toString()} (+${(amtTol * 100).toFixed(2)}%)`);
  }

  return { matched: issues.length === 0, issues };
}
