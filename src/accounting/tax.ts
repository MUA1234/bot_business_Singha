/**
 * Tax calculations (Architecture V2 change plan §8.3). Pure and deterministic, decimal
 * money via Money (Constitution §8). Rates are percentages (e.g. 15 = 15%).
 *
 * The rate factors are computed in Decimal, never via JS float division — `String(ratePct / 100)`
 * and `String(1 / factor)` fed float artifacts (e.g. 1/1.15 = 0.8695652173913044…) straight into
 * exact Money math, defeating the point of Money.
 */
import Decimal from "decimal.js";
import { Money } from "@/lib/money";

/** Tax on a net amount. */
export function taxAmount(net: string, ratePct: number | string, currency: string): string {
  const rate = new Decimal(String(ratePct)).div(100);
  return Money.of(net, currency).times(rate).round().toString();
}

/** Gross = net + tax. */
export function grossFromNet(net: string, ratePct: number | string, currency: string): string {
  const n = Money.of(net, currency);
  return n.plus(Money.of(taxAmount(net, ratePct, currency), currency)).toString();
}

/** Net back-calculated from a tax-inclusive gross amount. */
export function netFromGross(gross: string, ratePct: number | string, currency: string): string {
  // net = gross / (1 + rate), divided in Decimal at Money's working precision.
  const factor = new Decimal(String(ratePct)).div(100).plus(1);
  return Money.of(new Decimal(Money.of(gross, currency).toRawString()).div(factor), currency)
    .round()
    .toString();
}
