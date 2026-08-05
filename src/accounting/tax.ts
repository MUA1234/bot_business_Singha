/**
 * Tax calculations (Architecture V2 change plan §8.3). Pure and deterministic, decimal
 * money via Money (Constitution §8). Rates are percentages (e.g. 15 = 15%).
 */
import { Money } from "@/lib/money";

/** Tax on a net amount. */
export function taxAmount(net: string, ratePct: number, currency: string): string {
  return Money.of(net, currency).times(String(ratePct / 100)).round().toString();
}

/** Gross = net + tax. */
export function grossFromNet(net: string, ratePct: number, currency: string): string {
  const n = Money.of(net, currency);
  return n.plus(Money.of(taxAmount(net, ratePct, currency), currency)).toString();
}

/** Net back-calculated from a tax-inclusive gross amount. */
export function netFromGross(gross: string, ratePct: number, currency: string): string {
  // net = gross / (1 + rate)
  const factor = 1 + ratePct / 100;
  return Money.of(gross, currency).times(String(1 / factor)).round().toString();
}
