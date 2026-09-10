/**
 * Finance-intent classification contract (FOUND-003).
 *
 * This is what a MODEL is permitted to say about a staff message that might describe a financial
 * event. It is a PROPOSAL and nothing more: the deterministic gate in
 * `src/lib/finance/intent-gate.ts` decides what actually happens, and the only thing that can
 * result is a persisted source event entering the existing policy/authority pipeline.
 *
 * Deliberately absent from this schema, because the model must not be able to express them:
 *   - any authority level or approval decision;
 *   - any account code, journal line or posting instruction;
 *   - any company id, actor id or approval recipient;
 *   - any instruction to pay, transfer or settle.
 * Amounts are STRINGS. A JSON number would already have lost precision by the time it arrived.
 */
import { z } from "zod";

export const FinanceIntentKind = z.enum([
  "payment_made", // "paid LKR 45,000 to Acme for cement"
  "expense_incurred", // a cost was incurred, not necessarily paid
  "invoice_received", // a supplier bill arrived
  "payment_received", // a customer paid us
  "none", // not a financial event
]);
export type FinanceIntentKind = z.infer<typeof FinanceIntentKind>;

export const FinanceIntent = z.object({
  kind: FinanceIntentKind,
  /** Decimal string exactly as read from the message, or null when not stated. */
  amountRaw: z.string().nullish(),
  /** Currency exactly as stated (e.g. "LKR", "Rs", "rupees"), or null. Normalised by the gate. */
  currencyRaw: z.string().nullish(),
  /** Counterparty name as written. Never an id — the model does not resolve identity. */
  counterpartyRaw: z.string().nullish(),
  /** Short quoted snippets the classification rests on. */
  evidenceRefs: z.array(z.string()).default([]),
  /** Whether the sender referred to a document/photo/receipt. */
  mentionsEvidenceDocument: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  /** What the model could not determine. Drives clarification rather than a guess. */
  missingInfo: z.array(z.string()).default([]),
});
export type FinanceIntent = z.infer<typeof FinanceIntent>;
