/**
 * Overnight campaign — regression tests for D-007: a WhatsApp customer could steer the price of
 * an auto-sent quotation.
 *
 * Two independent flaws on the customer-facing pricing path, both reachable by anyone who can
 * message the business number:
 *
 *  1. The catalogue match also tested `name.includes(desc)` — the reverse direction — so a one-
 *     or two-character description matched nearly every catalogue row, and the first row of an
 *     unordered query won. The sender chose the description, so the sender steered which unit
 *     price was applied.
 *  2. The line total multiplied the catalogue unit price by the raw `quantity` from the model's
 *     reading of the message. That field is `z.number().positive()`, so `0.001` is valid — and
 *     the resulting quotation still satisfies every downstream check (status `priced`, non-null
 *     unit_price/line_total, matching currency, SUM(line_total) == total), so it reaches `ready`
 *     and is auto-sent as a branded commercial document.
 *
 * D-017 says the AI never produces a price. It did not — but the customer supplied the multiplier
 * and steered the selection, which defeats the control in effect. Both are now refused for
 * auto-pricing and fall through to the human price-confirmation path that already exists.
 */
import { describe, it, expect } from "vitest";
import { matchCatalogueEntry, isAutoPriceableQuantity, autoPriceQuantity } from "@/lib/quotations";

const CATALOG = [
  { name: "Premium Steel Beam", unit_price: "100000.00", currency: "LKR" },
  { name: "Anchor Bolt", unit_price: "250.00", currency: "LKR" },
];

describe("campaign D-007a — catalogue matching cannot be steered by a short description", () => {
  it("a single character does not match an expensive catalogue entry", () => {
    expect(matchCatalogueEntry("a", CATALOG)).toBeUndefined();
    expect(matchCatalogueEntry("b", CATALOG)).toBeUndefined();
  });

  it("a short substring of a catalogue name does not match it", () => {
    // "beam" is contained in "Premium Steel Beam"; under the old reverse test this matched.
    expect(matchCatalogueEntry("beam", CATALOG)).toBeUndefined();
    expect(matchCatalogueEntry("steel", CATALOG)).toBeUndefined();
  });

  it("an exact catalogue name still matches", () => {
    expect(matchCatalogueEntry("Premium Steel Beam", CATALOG)?.unit_price).toBe("100000.00");
    expect(matchCatalogueEntry("anchor bolt", CATALOG)?.unit_price).toBe("250.00");
  });

  it("a description that CONTAINS the catalogue name still matches (the useful direction)", () => {
    expect(matchCatalogueEntry("5x Premium Steel Beam, galvanised", CATALOG)?.unit_price).toBe("100000.00");
  });

  it("an empty or whitespace description matches nothing", () => {
    expect(matchCatalogueEntry("", CATALOG)).toBeUndefined();
    expect(matchCatalogueEntry("   ", CATALOG)).toBeUndefined();
    expect(matchCatalogueEntry(null, CATALOG)).toBeUndefined();
  });
});

describe("campaign D-007b — a fractional or absurd quantity is never auto-priced", () => {
  it("a fraction of an item is refused (the 0.001 × price attack)", () => {
    expect(isAutoPriceableQuantity(0.001)).toBe(false);
    expect(isAutoPriceableQuantity(0.5)).toBe(false);
    expect(isAutoPriceableQuantity(0.999999)).toBe(false);
  });

  it("zero, negative, NaN and Infinity are refused", () => {
    for (const q of [0, -1, -0.5, NaN, Infinity, -Infinity]) {
      expect(isAutoPriceableQuantity(q)).toBe(false);
    }
  });

  it("an absurd quantity is refused rather than silently priced", () => {
    expect(isAutoPriceableQuantity(1e9)).toBe(false);
    expect(isAutoPriceableQuantity(1_000_001)).toBe(false);
  });

  it("ordinary whole quantities are still auto-priced", () => {
    for (const q of [1, 2, 5, 100, 1_000_000]) {
      expect(isAutoPriceableQuantity(q)).toBe(true);
      expect(autoPriceQuantity(q)).toBe(q);
    }
  });

  it("a refused quantity leaves the line for a human instead of reinterpreting it", () => {
    // The point of the guard: not to coerce 0.001 into 1 (that would invent an order the customer
    // did not place), but to decline to auto-price it at all.
    expect(isAutoPriceableQuantity(0.001)).toBe(false);
  });
});
