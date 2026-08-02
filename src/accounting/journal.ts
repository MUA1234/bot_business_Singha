/**
 * Double-entry posting engine — Accounting Core v0. Guide §9 invariants.
 *
 * This module is PURE: given a posting input and a read-only ledger context, it
 * returns either an immutable posted journal or a domain error. Persistence,
 * transactions and idempotency-key uniqueness are the caller's job (the DB layer),
 * but every *rule* that decides whether a posting is legal lives here so it can be
 * unit-tested against the golden dataset without a database.
 */
import { Money, sumMoney } from "@/lib/money";
import { err, ok, type Result, fail } from "@/lib/result";
import type { AccountType } from "@/domain/accounts";
import { normalBalance } from "@/domain/accounts";
import type { JournalPostingInput } from "@/schemas/posting";

export interface AccountRef {
  code: string;
  company_id: string;
  type: AccountType;
  is_active: boolean;
}

export interface PeriodStatus {
  /** true when the posting_date falls in a closed/locked period. */
  isClosed: boolean;
  periodId: string | null;
}

/** Read-only view the engine needs. Implemented by the DB layer in production. */
export interface LedgerContext {
  getAccount(companyId: string, code: string): AccountRef | undefined;
  getPeriodStatus(companyId: string, postingDate: string): PeriodStatus;
}

export interface PostedLine {
  account_code: string;
  account_type: AccountType;
  debit: string; // canonical decimal string
  credit: string;
  description: string | null;
  dimensions: {
    project_id: string | null;
    division_id: string | null;
    site_id: string | null;
    cost_centre_id: string | null;
    customer_id: string | null;
    supplier_id: string | null;
    employee_id: string | null;
  };
}

export interface PostedJournal {
  readonly company_id: string;
  readonly currency: string;
  readonly exchange_rate: string;
  readonly posting_date: string;
  readonly period_id: string | null;
  readonly memo: string | null;
  readonly source_event_id: string | null;
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly approval_request_id: string | null;
  readonly reversal_of_journal_id: string | null;
  readonly lines: readonly PostedLine[];
  readonly total_debit: string;
  readonly total_credit: string;
  /** Marks the object immutable in-domain (guide §9: posted entries can't change). */
  readonly immutable: true;
}

/**
 * Validate + build a posted journal from a (already Zod-parsed) posting input.
 * Enforces: single company, balance, account existence/activity/company match,
 * open period, and line-side sanity.
 */
export function buildPostedJournal(
  input: JournalPostingInput,
  ctx: LedgerContext,
): Result<PostedJournal> {
  // Period must be open (guide §9: closed periods reject ordinary posting).
  const period = ctx.getPeriodStatus(input.company_id, input.posting_date);
  if (period.isClosed) {
    return fail("PERIOD_CLOSED", `Cannot post into a closed period on ${input.posting_date}`, {
      posting_date: input.posting_date,
    });
  }

  const debits: Money[] = [];
  const credits: Money[] = [];
  const postedLines: PostedLine[] = [];

  for (const [i, line] of input.lines.entries()) {
    const account = ctx.getAccount(input.company_id, line.account_code);
    if (!account) {
      return fail("ACCOUNT_NOT_FOUND", `Account ${line.account_code} not found in company`, {
        line: i,
        account_code: line.account_code,
      });
    }
    // Company isolation at the line level (guide §9: a journal belongs to exactly
    // one legal company — every account it touches must be that company's).
    if (account.company_id !== input.company_id) {
      return fail("CROSS_COMPANY_LINE", `Account ${line.account_code} belongs to another company`, {
        line: i,
      });
    }
    if (!account.is_active) {
      return fail("ACCOUNT_INACTIVE", `Account ${line.account_code} is inactive`, { line: i });
    }

    const debit = Money.of(line.debit, input.currency);
    const credit = Money.of(line.credit, input.currency);
    if (debit.isNegative() || credit.isNegative()) {
      return fail("NEGATIVE_AMOUNT", `Line ${i} has a negative amount`, { line: i });
    }
    debits.push(debit);
    credits.push(credit);

    postedLines.push({
      account_code: account.code,
      account_type: account.type,
      debit: debit.toString(),
      credit: credit.toString(),
      description: line.description,
      dimensions: {
        project_id: line.project_id,
        division_id: line.division_id,
        site_id: line.site_id,
        cost_centre_id: line.cost_centre_id,
        customer_id: line.customer_id,
        supplier_id: line.supplier_id,
        employee_id: line.employee_id,
      },
    });
  }

  const totalDebit = sumMoney(debits).round();
  const totalCredit = sumMoney(credits).round();

  // The central invariant: debits == credits (guide §9, invariant #12).
  if (!totalDebit.equals(totalCredit)) {
    return fail("UNBALANCED", `Journal is unbalanced: debit ${totalDebit} ≠ credit ${totalCredit}`, {
      total_debit: totalDebit.toString(),
      total_credit: totalCredit.toString(),
    });
  }
  if (totalDebit.isZero()) {
    return fail("ZERO_VALUE", "A journal with zero total value is not allowed");
  }

  return ok({
    company_id: input.company_id,
    currency: input.currency,
    exchange_rate: input.exchange_rate,
    posting_date: input.posting_date,
    period_id: period.periodId,
    memo: input.memo,
    source_event_id: input.source_event_id,
    correlation_id: input.correlation_id,
    idempotency_key: input.idempotency_key,
    approval_request_id: input.approval_request_id,
    reversal_of_journal_id: input.reversal_of_journal_id,
    lines: postedLines,
    total_debit: totalDebit.toString(),
    total_credit: totalCredit.toString(),
    immutable: true,
  });
}

/**
 * Build the reversing journal for an already-posted journal. Guide §9: corrections
 * use reversals; the reversal references the original and swaps debit/credit. The
 * caller supplies a fresh idempotency key + correlation id and the reversal date
 * (which must itself land in an open period — re-checked by buildPostedJournal).
 */
export function buildReversal(
  original: PostedJournal,
  opts: {
    reversalDate: string;
    correlationId: string;
    idempotencyKey: string;
    originalJournalId: string;
    memo?: string | null;
    approvalRequestId?: string | null;
  },
  ctx: LedgerContext,
): Result<PostedJournal> {
  const reversedInput: JournalPostingInput = {
    contract_version: "1.0",
    company_id: original.company_id,
    currency: original.currency,
    exchange_rate: original.exchange_rate,
    posting_date: opts.reversalDate,
    memo: opts.memo ?? `Reversal of journal ${opts.originalJournalId}`,
    source_event_id: original.source_event_id,
    correlation_id: opts.correlationId,
    idempotency_key: opts.idempotencyKey,
    approval_request_id: opts.approvalRequestId ?? null,
    reversal_of_journal_id: opts.originalJournalId,
    lines: original.lines.map((l) => ({
      account_code: l.account_code,
      debit: l.credit, // swap
      credit: l.debit,
      description: `Reversal: ${l.description ?? ""}`.trim(),
      project_id: l.dimensions.project_id,
      division_id: l.dimensions.division_id,
      site_id: l.dimensions.site_id,
      cost_centre_id: l.dimensions.cost_centre_id,
      customer_id: l.dimensions.customer_id,
      supplier_id: l.dimensions.supplier_id,
      employee_id: l.dimensions.employee_id,
    })),
  };
  return buildPostedJournal(reversedInput, ctx);
}

/** Signed contribution of a posted line to its account's running balance. */
export function signedLineAmount(line: PostedLine, currency: string): Money {
  const debit = Money.of(line.debit, currency);
  const credit = Money.of(line.credit, currency);
  const net = debit.minus(credit); // debit-positive convention
  return normalBalance(line.account_type) === "debit" ? net : Money.zero(currency).minus(net);
}

// re-export for callers that only import the engine
export { err, ok };
