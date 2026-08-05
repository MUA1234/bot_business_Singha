/**
 * Petty cash count variance (Architecture V2 change plan §8.3). Pure, decimal money.
 * Variance = counted − book (positive = surplus, negative = shortage).
 */
import { Money } from "@/lib/money";

export function cashVariance(counted: string, book: string, currency: string): string {
  return Money.of(counted, currency).minus(Money.of(book, currency)).toString();
}
