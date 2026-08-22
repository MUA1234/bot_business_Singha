/**
 * Server helper: load a company's posted journals as PostedJournal[] for the reports
 * (trial balance, P&L, balance sheet). Derivation stays in the pure accounting core
 * so every statement reconciles to the ledger. Company-scoped; graceful pre-data.
 */
import { supabaseReadClient } from "@/lib/supabase/read";
import type { PostedJournal } from "@/accounting/journal";
import type { AccountType } from "@/domain/accounts";

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export async function loadPostedJournals(companyId: string): Promise<{ journals: PostedJournal[]; currency: string }> {
  const db = supabaseReadClient();
  const [journals, lines, accounts] = await Promise.all([
    safe<any>(() => db.from("journal_entries").select("id, currency").eq("company_id", companyId).eq("status", "posted") as any),
    safe<any>(() => db.from("journal_lines").select("journal_id, account_code, debit, credit").eq("company_id", companyId) as any),
    safe<any>(() => db.from("chart_of_accounts").select("code, type").eq("company_id", companyId) as any),
  ]);

  const typeByCode = new Map<string, AccountType>(accounts.map((a) => [a.code, a.type as AccountType]));
  const linesByJournal = new Map<string, any[]>();
  for (const l of lines) {
    const list = linesByJournal.get(l.journal_id) ?? [];
    list.push(l);
    linesByJournal.set(l.journal_id, list);
  }

  const currency = journals[0]?.currency ?? "LKR";
  const posted = journals.map((j) => ({
    currency: j.currency,
    lines: (linesByJournal.get(j.id) ?? []).map((l) => ({
      account_code: l.account_code,
      account_type: typeByCode.get(l.account_code) ?? ("asset" as AccountType),
      debit: String(l.debit ?? 0),
      credit: String(l.credit ?? 0),
    })),
  })) as unknown as PostedJournal[];

  return { journals: posted, currency };
}
