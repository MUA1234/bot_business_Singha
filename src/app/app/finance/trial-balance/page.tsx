/**
 * Finance → Trial Balance (§8.1). Derived purely from posted journal lines via the
 * accounting core (trialBalance / profitAndLoss / balanceSheet) so it always
 * reconciles to the ledger. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { dec, decGtZero, fmtMoney } from "@/lib/money";
import { trialBalance, profitAndLoss, balanceSheet } from "@/accounting/trial-balance";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { PageHead, Section, Signal, StateNote } from "@/components/os/primitives";
import type { PostedJournal } from "@/accounting/journal";
import type { AccountType } from "@/domain/accounts";

export const metadata = { title: "Trial Balance — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function TrialBalancePage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [journals, lines, accounts] = await Promise.all([
    safe<any>(() => db.from("journal_entries").select("id, currency").eq("company_id", p.companyId).eq("status", "posted") as any),
    safe<any>(() => db.from("journal_lines").select("journal_id, account_code, debit, credit").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("chart_of_accounts").select("code, name, type").eq("company_id", p.companyId) as any),
  ]);

  const typeByCode = new Map<string, AccountType>(accounts.map((a) => [a.code, a.type as AccountType]));
  const linesByJournal = new Map<string, any[]>();
  for (const l of lines) {
    const list = linesByJournal.get(l.journal_id) ?? [];
    list.push(l);
    linesByJournal.set(l.journal_id, list);
  }

  const currency = journals[0]?.currency ?? "LKR";
  const posted: PostedJournal[] = journals.map((j) => ({
    currency: j.currency,
    lines: (linesByJournal.get(j.id) ?? []).map((l) => ({
      account_code: l.account_code,
      account_type: typeByCode.get(l.account_code) ?? ("asset" as AccountType),
      debit: String(l.debit ?? 0),
      credit: String(l.credit ?? 0),
    })),
  })) as unknown as PostedJournal[];

  const tb = trialBalance(posted, currency);
  const pnl = profitAndLoss(tb);
  const bs = balanceSheet(tb);
  const m = (v: string) => fmtMoney(v, currency);

  const accountName = new Map<string, string>(accounts.map((a: any) => [a.code, a.name as string]));

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Accounting"
        title="Trial balance"
        lede="Derived purely from posted journal lines, so it always reconciles to the ledger. Nothing on this screen is entered by hand."
        actions={
          <Link className="btn ghost sm" href="/app/finance/journals">
            <Icon name="chevron-left" size={14} /> Journals
          </Link>
        }
      />

      <Section title="Position" meta={`${tb.rows.length} account(s) with a balance`} />
      <div className="grid cols-3">
        <div className="card stat">
          <div className="k">Net profit</div>
          <div className="v" style={{ color: dec(pnl.net_profit).isNegative() ? "var(--danger)" : undefined }}>
            {m(pnl.net_profit)}
          </div>
          <div className="d">Income less expenditure, from posted journals</div>
        </div>
        <div className="card stat">
          <div className="k">Assets</div>
          <div className="v">{m(bs.assets)}</div>
          <div className="d">Total of every asset account</div>
        </div>
        <div className="card stat">
          <div className="k">Assets = liabilities + equity</div>
          <div className="v" style={{ fontSize: "var(--t-h2)" }}>
            {bs.balances ? "In balance" : "Out of balance"}
          </div>
          <div className="d">
            {bs.balances ? (
              <Signal kind="ok">The accounting identity holds</Signal>
            ) : (
              <Signal kind="critical">The ledger does not balance — investigate before relying on it</Signal>
            )}
          </div>
        </div>
      </div>

      <Section
        title="Trial balance"
        meta={tb.balanced ? "debits equal credits" : "debits do not equal credits"}
      />
      {tb.rows.length === 0 ? (
        <StateNote kind="empty" title="No posted journals yet">
          A trial balance is derived from posted journals. Until one is posted there is nothing to
          derive — this is an empty ledger, not a failed read.
        </StateNote>
      ) : (
        <div className="card">
          <div className="row between wrap gap-2" style={{ marginBottom: "var(--sp-3)" }}>
            {tb.balanced ? (
              <Signal kind="ok">Balanced</Signal>
            ) : (
              <Signal kind="critical">Unbalanced</Signal>
            )}
            <span className="small dim">Every row is a posted balance; none is entered here.</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.account_code}>
                    <td className="mono">{r.account_code}</td>
                    <td>{accountName.get(r.account_code) ?? <span className="dim">name not recorded</span>}</td>
                    <td><Badge>{r.account_type}</Badge></td>
                    <td className="num">{decGtZero(r.debit) ? m(r.debit) : "—"}</td>
                    <td className="num">{decGtZero(r.credit) ? m(r.credit) : "—"}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 700 }}>Total</td>
                  <td />
                  <td />
                  <td className="num" style={{ fontWeight: 700 }}>{m(tb.total_debit)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{m(tb.total_credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
