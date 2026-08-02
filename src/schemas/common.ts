/**
 * Shared Zod primitives. Everything the AI produces or an API accepts is parsed
 * through these — never trusted as free text (guide §2 rule 7, §13).
 */
import { z } from "zod";

/** Canonical positive/zero decimal money string, e.g. "14500.00". No floats. */
export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/u, "must be a decimal string, not a float or number");

export const positiveDecimalString = decimalString.refine(
  (s) => !s.startsWith("-") && Number(s) !== 0,
  "must be greater than zero",
);

export const currencyCode = z.string().regex(/^[A-Z]{3}$/u, "ISO 4217 currency code");

/** ISO date (no time) — accounting works on calendar dates. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "YYYY-MM-DD");

export const uuid = z.string().uuid();
export const nullableUuid = uuid.nullable();

/** A confidence value in [0,1]. */
export const confidence01 = z.number().min(0).max(1);

/** Company scope is mandatory on every financial record (core principle #2). */
export const companyId = uuid;
