/**
 * Inventory helpers (Architecture V2 change plan §9.2). Pure and deterministic:
 * reorder detection and stock valuation. Unit costs are decimal strings via Money
 * (Constitution §8); quantities are ordinary numbers.
 */
import { Money } from "@/lib/money";

export interface StockItem {
  name: string;
  quantityOnHand: number;
  reorderLevel: number;
  unitCost: string; // decimal string
}

/** At or below the reorder level (and the level is meaningful). */
export function needsReorder(item: Pick<StockItem, "quantityOnHand" | "reorderLevel">): boolean {
  return item.reorderLevel > 0 && item.quantityOnHand <= item.reorderLevel;
}

export function reorderList<T extends Pick<StockItem, "quantityOnHand" | "reorderLevel">>(items: T[]): T[] {
  return items.filter(needsReorder);
}

/** Total value = Σ quantity × unit cost (decimal). Assumes one currency. */
export function stockValuation(items: StockItem[], currency: string): string {
  let total = Money.zero(currency);
  for (const it of items) {
    if (it.quantityOnHand <= 0) continue;
    total = total.plus(Money.of(it.unitCost || "0", currency).times(it.quantityOnHand));
  }
  return total.toString();
}
