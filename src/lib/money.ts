/**
 * Fixed-precision money. Guide invariant #11: never use floating-point for money.
 *
 * All monetary values are carried as `Decimal` internally and serialised as
 * canonical decimal strings (e.g. "14500.00") at the boundaries. We never accept
 * or emit a JS `number` for an amount.
 */
import Decimal from "decimal.js";

// Bankers' rounding is the safest default for accounting sums.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** Number of decimal places to store/present for a given ISO currency code. */
export function currencyScale(currency: string): number {
  // Zero-decimal currencies (subset). Everything else defaults to 2.
  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "XAF", "XOF"]);
  const threeDecimal = new Set(["BHD", "KWD", "OMR", "TND", "IQD", "JOD", "LYD"]);
  if (zeroDecimal.has(currency)) return 0;
  if (threeDecimal.has(currency)) return 3;
  return 2;
}

export class Money {
  readonly amount: Decimal;
  readonly currency: string;

  private constructor(amount: Decimal, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  /** Parse from a canonical decimal string. Rejects floats, NaN, Infinity. */
  static of(value: string | Decimal, currency: string): Money {
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`Invalid currency code: ${JSON.stringify(currency)}`);
    }
    let d: Decimal;
    if (value instanceof Decimal) {
      d = value;
    } else {
      if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value.trim())) {
        throw new Error(`Invalid decimal money string: ${JSON.stringify(value)}`);
      }
      d = new Decimal(value.trim());
    }
    if (!d.isFinite()) throw new Error("Money amount must be finite");
    return new Money(d, currency);
  }

  static zero(currency: string): Money {
    return Money.of("0", currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}. Cross-currency math must be explicit.`,
      );
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a dimensionless factor (e.g. tax rate, quantity). */
  times(factor: string | number | Decimal): Money {
    return new Money(this.amount.times(new Decimal(factor)), this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  /** Round to the currency's minor units. */
  round(): Money {
    return new Money(this.amount.toDecimalPlaces(currencyScale(this.currency)), this.currency);
  }

  /** Canonical string at the currency scale, e.g. "14500.00". */
  toString(): string {
    return this.amount.toFixed(currencyScale(this.currency));
  }

  /** Raw string without forcing scale — used for exact ledger storage. */
  toRawString(): string {
    return this.amount.toFixed();
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }
}

/** Sum a list of same-currency Money values. Throws on empty (currency unknown). */
export function sumMoney(values: Money[]): Money {
  if (values.length === 0) throw new Error("sumMoney requires at least one value");
  return values.reduce((acc, v) => acc.plus(v));
}

/**
 * Parse a user/form money input into Money WITHOUT going through a JS float.
 * Accepts a canonical decimal string (or a value that stringifies to one); returns
 * null for empty/malformed input so callers can reject or treat as absent. Never use
 * `Number(...)` on money — this is the safe entry point (Constitution invariant #11).
 */
export function parseMoneyInput(raw: unknown, currency: string): Money | null {
  const s = String(raw ?? "").trim();
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  try {
    return Money.of(s, currency);
  } catch {
    return null;
  }
}

/** Canonical line total = unit price × integer quantity, rounded to the currency. */
export function lineTotal(unitPrice: Money, quantity: number): Money {
  const q = Math.max(0, Math.trunc(quantity));
  return unitPrice.times(q).round();
}
