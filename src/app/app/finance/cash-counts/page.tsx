/**
 * Finance → Cash Counts (§8.3). Record a physical count of a cash account; the system
 * computes the book balance and stores the variance. Company-scoped + audited.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { dec, fmtMoney } from "@/lib/money";
import { recordCashCount } from "./actions";

export const metadata = { title: "Cash Counts — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function CashCountsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const [accounts, counts] = await Promise.all([
    safe<any>(() => db.from("cash_accounts").select("id, name, currency").eq("company_id", p.companyId).order("name") as any),
    safe<any>(() => db.from("cash_counts").select("id, counted_amount, variance, counted_at, cash_accounts(name, currency)").eq("company_id", p.companyId).order("counted_at", { ascending: false }).limit(100) as any),
  ]);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Cash Counts</h1><p className="muted mt-1">Reconcile physical cash to the books.</p></div>
        <Link className="btn ghost sm" href="/app/finance/accounts">Bank & Cash →</Link>
      </div>

      <div className="card">
        <div className="card-title">Record a count</div>
        {accounts.length === 0 ? (
          <div className="empty">Add a <Link href="/app/finance/accounts">cash account</Link> first.</div>
        ) : (
          <form action={recordCashCount} className="row gap-1 wrap mt-2">
            <select name="cash_account_id" className="select" style={{ width: 200 }}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
            </select>
            <input name="counted_amount" className="input" style={{ width: 140 }} placeholder="Counted amount" inputMode="decimal" />
            <button className="btn" type="submit">Record</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="card-title">History ({counts.length})</div>
        {counts.length === 0 ? <div className="empty">No counts yet.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Account</th><th className="num">Counted</th><th className="num">Variance</th><th>When</th></tr></thead>
              <tbody>
                {counts.map((c) => {
                  const v = dec(c.variance);
                  return (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.cash_accounts?.name ?? "—"}</td>
                      <td className="num">{fmtMoney(c.counted_amount, c.cash_accounts?.currency)}</td>
                      <td className="num" style={{ color: v.isNegative() ? "var(--danger)" : v.greaterThan(0) ? "var(--warn)" : "var(--ok)" }}>{v.greaterThan(0) ? "+" : ""}{fmtMoney(v)}</td>
                      <td className="dim small">{c.counted_at ? new Date(c.counted_at).toLocaleString() : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
