/**
 * Loan amortization (Architecture V2 change plan §8.3). Pure and deterministic:
 * a reducing-balance equal-installment (EMI) schedule. All money is fixed-precision
 * Decimal, serialised as 2dp strings (Constitution §8); the final installment absorbs
 * rounding so the balance clears to exactly zero.
 */
import Decimal from "decimal.js";

export interface Installment {
  seq: number;
  dueDate: string; // ISO date
  principal: string;
  interest: string;
  balance: string; // remaining after this installment
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

/** Monthly schedule for `principal` at `annualRatePct` over `termMonths`.
 *  All amounts are rounded to 2dp AS THEY ACCRUE, so the displayed principals sum
 *  exactly to the loan and the balance clears to zero. */
export function amortizationSchedule(principal: string, annualRatePct: number, termMonths: number, startDate: string): Installment[] {
  const n = Math.max(1, Math.trunc(termMonths));
  const r = new Decimal(annualRatePct).div(1200); // monthly rate

  const out: Installment[] = [];
  let balance = round2(new Decimal(principal));

  // Equal principal when interest-free; otherwise the standard EMI (rounded to money).
  const emi = round2(
    r.isZero()
      ? balance.div(n)
      : (() => {
          const pow = r.plus(1).pow(n);
          return balance.mul(r).mul(pow).div(pow.minus(1));
        })(),
  );

  for (let seq = 1; seq <= n; seq++) {
    const interest = r.isZero() ? new Decimal(0) : round2(balance.mul(r));
    let principalPart = seq === n ? balance : emi.minus(interest);
    if (principalPart.greaterThan(balance)) principalPart = balance; // never overpay
    if (principalPart.lessThan(0)) principalPart = new Decimal(0);
    balance = balance.minus(principalPart);
    out.push({
      seq,
      dueDate: addMonths(startDate, seq),
      principal: principalPart.toFixed(2),
      interest: interest.toFixed(2),
      balance: balance.toFixed(2),
    });
  }
  return out;
}
