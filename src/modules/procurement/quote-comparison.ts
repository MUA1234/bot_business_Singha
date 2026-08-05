/**
 * Supplier quotation comparison (Architecture V2 change plan §9.2). Pure and
 * deterministic: ranks quotations by total (cheapest first, lead time as tiebreak)
 * and reports the potential saving vs the most expensive. Amounts are decimal strings
 * via Money (Constitution §8). It ranks; the award decision stays with a human.
 */
import { Money } from "@/lib/money";

export interface Quotation {
  id: string;
  supplierName: string;
  total: string; // decimal string
  leadTimeDays: number | null;
}

export interface RankedQuotation extends Quotation {
  rank: number;
  isCheapest: boolean;
}

export interface Comparison {
  currency: string;
  ranked: RankedQuotation[];
  cheapestId: string | null;
  saving: string; // highest total − lowest total
}

export function compareQuotations(quotes: Quotation[], currency: string): Comparison {
  if (quotes.length === 0) return { currency, ranked: [], cheapestId: null, saving: "0" };

  const sorted = [...quotes].sort((a, b) => {
    const cmp = Money.of(a.total, currency).compare(Money.of(b.total, currency));
    if (cmp !== 0) return cmp;
    return (a.leadTimeDays ?? Infinity) - (b.leadTimeDays ?? Infinity); // cheaper first, then faster
  });

  const ranked: RankedQuotation[] = sorted.map((q, i) => ({ ...q, rank: i + 1, isCheapest: i === 0 }));
  const lowest = Money.of(sorted[0]!.total, currency);
  const highest = Money.of(sorted[sorted.length - 1]!.total, currency);
  return {
    currency,
    ranked,
    cheapestId: sorted[0]!.id,
    saving: highest.minus(lowest).toString(),
  };
}
