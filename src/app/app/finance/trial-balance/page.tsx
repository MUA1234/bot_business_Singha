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
    safe<any>(() => db.from("chart_of_accounts").select("code, type").eq("company_id", p.companyId) as any),
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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Trial Balance</h1>
          <p className="muted mt-1">Derived from posted journals. {tb.balanced ? "In balance." : "Out of balance."}</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/journals">← Journals</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Net profit</div><div className="v" style={{ fontSize: "1.4rem", color: dec(pnl.net_profit).isNegative() ? "var(--danger)" : "var(--ok)" }}>{m(pnl.net_profit)}</div></div>
        <div className="card stat"><div className="k">Assets</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(bs.assets)}</div></div>
        <div className="card stat"><div className="k">A = L + E</div><div className="v" style={{ fontSize: "1.4rem", color: bs.balances ? "var(--ok)" : "var(--danger)" }}>{bs.balances ? "balances" : "off"}</div></div>
      </div>

      <div className="card">
        <div className="card-title">Trial balance {tb.balanced ? <span className="badge ok">balanced</span> : <span className="badge danger">unbalanced</span>}</div>
        {tb.rows.length === 0 ? (
          <div className="empty">No posted journals yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Account</th><th>Type</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.account_code}>
                    <td className="mono">{r.account_code}</td>
                    <td><span className="badge">{r.account_type}</span></td>
                    <td className="num">{decGtZero(r.debit) ? m(r.debit) : "—"}</td>
                    <td className="num">{decGtZero(r.credit) ? m(r.credit) : "—"}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 700 }}>Total</td><td></td>
                  <td className="num" style={{ fontWeight: 700 }}>{m(tb.total_debit)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{m(tb.total_credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
