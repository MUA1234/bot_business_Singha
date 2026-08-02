/**
 * Journal-posting contract. Guide §9 invariants. This is the versioned contract
 * that connects an approved financial-event draft to the Accounting Core. The
 * posting engine (src/accounting/journal.ts) consumes only this shape.
 *
 * Note: this schema enforces *structure*. The balance check, period-lock check,
 * company-isolation check and immutability are enforced by the engine, because
 * they require looking at real rows — Zod cannot see the ledger.
 */
import { z } from "zod";
import { companyId, currencyCode, decimalString, isoDate, uuid } from "./common";

export const POSTING_CONTRACT_VERSION = "1.0" as const;

export const journalLineInput = z
  .object({
    account_code: z.string().min(1),
    /** Exactly one of debit/credit is non-zero. Enforced by refine below. */
    debit: decimalString.default("0"),
    credit: decimalString.default("0"),
    description: z.string().max(1000).nullable().default(null),
    // dimensional allocation (guide §5)
    project_id: uuid.nullable().default(null),
    division_id: uuid.nullable().default(null),
    site_id: uuid.nullable().default(null),
    cost_centre_id: uuid.nullable().default(null),
    customer_id: uuid.nullable().default(null),
    supplier_id: uuid.nullable().default(null),
    employee_id: uuid.nullable().default(null),
  })
  .refine(
    (l) => (l.debit !== "0") !== (l.credit !== "0"),
    "each line must have exactly one of debit or credit non-zero",
  );

export type JournalLineInput = z.infer<typeof journalLineInput>;

export const journalPostingInput = z.object({
  contract_version: z.literal(POSTING_CONTRACT_VERSION),
  company_id: companyId,
  currency: currencyCode,
  /** Base-currency rate; "1" when currency === base. Retained per guide §9. */
  exchange_rate: decimalString.default("1"),
  posting_date: isoDate,
  memo: z.string().max(2000).nullable().default(null),
  /** Provenance — every posting records its source + trace (guide §9). */
  source_event_id: uuid.nullable().default(null),
  correlation_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  approval_request_id: uuid.nullable().default(null),
  reversal_of_journal_id: uuid.nullable().default(null),
  lines: z.array(journalLineInput).min(2, "a journal needs at least two lines"),
});

export type JournalPostingInput = z.infer<typeof journalPostingInput>;
