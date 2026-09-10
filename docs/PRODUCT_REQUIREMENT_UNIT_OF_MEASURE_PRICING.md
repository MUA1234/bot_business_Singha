# Product requirement — unit-of-measure pricing and catalogue identity

> Status: **REQUIREMENT, NOT IMPLEMENTED.** Recorded at owner instruction after the verification
> campaign's D-007 correction. Nothing in this document is built. Do not describe any of it as
> available.
>
> Context: the campaign found that a WhatsApp customer could steer the price of an auto-sent
> quotation, via a catalogue match decided by row order and a `quantity` the schema allowed to be
> `0.001`. The interim correction is deliberately conservative and is **approved as a safety
> control**, not as the final product behaviour. This document defines what has to exist before the
> conservative behaviour can be relaxed.

## Approved interim behaviour (preserve — do not relax without the below)

| Rule | Status |
|---|---|
| Fuzzy or partial-name catalogue matches may **suggest** a product but may **not** autonomously determine price | enforced (`matchCatalogueEntry`) |
| Ambiguous matches (equally specific, different prices) are refused, not guessed | enforced |
| Fractional or by-weight quantities require human confirmation | enforced (`isAutoPriceableQuantity`) |
| Exact catalogue identity + validated whole-unit quantity may auto-price | enforced |
| AI or customer text must never control the effective multiplier without deterministic validation | enforced |

The regression tests for these live in `tests/campaign/quotation-pricing-guard.test.ts` and must not
be weakened to make a future feature pass.

**Known cost of the interim rule, stated plainly:** a business that sells by weight, length or
volume currently sends **every** line to a human, and a customer who writes "steel beam" for the
catalogue entry "Premium Steel Beam 200mm" also goes to a human. That is the correct default while
the model below does not exist, and it is the reason this requirement is worth building.

## Required data model

### Catalogue identity
- `sku` — the business's own stable code. Unique per company.
- `barcode` / `gtin` — optional, unique per company when present.
- `name`, plus an explicit `aliases[]` for the phrasings customers actually use.
- Matching precedence, deterministic and total: **exact SKU → exact barcode → exact alias → exact
  name → (suggestion only)**. A suggestion never prices; it proposes to a human.

### Unit of measure
- `base_unit` — the unit the price is quoted in (`each`, `kg`, `g`, `m`, `m2`, `m3`, `litre`, `hour`).
- `price_per_base_unit` — exact decimal, with the currency.
- `sale_unit` + `sale_unit_factor` — e.g. sold per box of 12: `sale_unit = box`, factor `12`.
  Conversion is exact decimal arithmetic; **never** a float, never an implicit conversion between
  incompatible dimensions (kg ↔ m must be impossible, not merely discouraged).

### Quantity rules (per catalogue entry)
- `quantity_precision` — permitted decimal places (`0` for discrete goods, e.g. `3` for kg).
- `min_quantity`, `max_quantity` — inclusive bounds; a quantity outside them is refused, not clamped.
- `quantity_step` — optional increment (e.g. sold only in multiples of 0.5 m).
- A quantity violating precision, bounds or step is **routed to a human**, never silently rounded
  into validity — rounding a customer's order into a different order is a fabrication.

### Rounding
- `rounding_mode` and `rounding_dp` per currency, applied **once**, at the line total, after exact
  multiplication. Intermediate values are never rounded.
- Currency scale comes from the currency, not from the caller.

## Required behaviour

1. **Auto-pricing is permitted only when** identity is exact (SKU/barcode/alias/name), the quantity
   satisfies precision + bounds + step, the unit is compatible with the catalogue's base unit, and
   the catalogue currency equals the quotation currency.
2. **Everything else becomes a staff-confirmed suggestion**, carrying: the candidate matches with
   their scores, the parsed quantity and unit, and what specifically failed validation.
3. **A staff confirmation is an authored decision** — recorded with actor, timestamp and the exact
   values confirmed, and it is what prices the line. The AI never supplies the number.
4. **The DB boundary must enforce the arithmetic**, not only the application: extend the enqueue
   guard so a queued line satisfies `line_total = round(price_per_base_unit × quantity_in_base_units)`.
   The campaign found the existing guard validates status, currency and the total sum but **not**
   quantity — which is why an internally-consistent wrong price shipped.
5. **Multi-currency** stays explicit: no implicit conversion anywhere in pricing, matching the rule
   already enforced for authority decisions.

## Acceptance tests this requirement must ship with

- exact SKU + whole quantity → auto-priced;
- exact SKU + quantity below `min`/above `max`/off `step` → human;
- by-weight entry with `quantity_precision = 3` → `2.500 kg` auto-prices; `2.5001 kg` → human;
- alias match → auto-prices; partial-name match → suggestion only;
- two candidates with different prices → refused;
- incompatible unit (kg against a per-metre entry) → refused, never converted;
- rounding applied once at the line total, verified against exact decimal expectations;
- DB-level: a queued line whose `line_total` disagrees with `price × quantity` is rejected.

## Owner gates

Building this requires an approved catalogue data-model migration and a staff-confirmation UI. It is
a **new feature program**, not a correction, and is out of scope for the architectural-blocker work.
