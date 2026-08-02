import type { AccountRef, LedgerContext, PeriodStatus } from "@/accounting/journal";
import type { AccountType } from "@/domain/accounts";

/** A tiny in-memory chart of accounts + period calendar for tests. */
export function makeLedgerContext(opts: {
  companyId: string;
  accounts: { code: string; type: AccountType; active?: boolean }[];
  closedBefore?: string; // any posting_date < this is "closed"
}): LedgerContext {
  const map = new Map<string, AccountRef>();
  for (const a of opts.accounts) {
    map.set(a.code, {
      code: a.code,
      company_id: opts.companyId,
      type: a.type,
      is_active: a.active ?? true,
    });
  }
  return {
    getAccount(companyId, code) {
      const acc = map.get(code);
      if (!acc) return undefined;
      // simulate cross-company: an account only belongs to opts.companyId
      return companyId === opts.companyId ? acc : { ...acc, company_id: opts.companyId };
    },
    getPeriodStatus(_companyId, postingDate): PeriodStatus {
      const isClosed = opts.closedBefore ? postingDate < opts.closedBefore : false;
      return { isClosed, periodId: isClosed ? null : "period-open" };
    },
  };
}
