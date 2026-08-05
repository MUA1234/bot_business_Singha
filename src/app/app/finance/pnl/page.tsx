/**
 * Finance → Profit & Loss (§8.1). Income less expense, per account, derived purely
 * from posted journals. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { loadPostedJournals } from "@/lib/ledger-report";
import { trialBalance, profitAndLoss } from "@/accounting/trial-balance";

export const metadata = { title: "Profit & Loss — Singha" };

export default async function PnlPage() {
  const p = await requireDepartment("finance");
  const { journals, currency } = await loadPostedJournals(p.companyId);
  const tb = trialBalance(journals, currency);
  const pnl = profitAndLoss(tb);
  const m = (v: string) => `${currency} ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  const incomeRows = tb.rows.filter((r) => r.account_type === "income");
  const expenseRows = tb.rows.filter((r) => r.account_type === "expense");
  const rowAmount = (r: { debit: string; credit: string }, side: "income" | "expense") =>
    side === "income" ? Number(r.credit) - Number(r.debit) : Number(r.debit) - Number(r.credit);

  const Section = ({ title, rows, side, total }: { title: string; rows: typeof tb.rows; side: "income" | "expense"; total: string }) => (
    <div className="card">
      <div className="card-title">{title}</div>
      {rows.length === 0 ? <div className="empty">Nothing posted.</div> : (
        <div className="table-wrap mt-3">
          <table className="data">
            <tbody>
              {rows.map((r) => (
                <tr key={r.account_code}><td className="mono">{r.account_code}</td><td className="num">{m(String(rowAmount(r, side)))}</td></tr>
              ))}
              <tr><td style={{ fontWeight: 700 }}>Total {title.toLowerCase()}</td><td className="num" style={{ fontWeight: 700 }}>{m(total)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Profit &amp; Loss</h1><p className="muted mt-1">From posted journals. Net {Number(pnl.net_profit) >= 0 ? "profit" : "loss"}.</p></div>
        <Link className="btn ghost sm" href="/app/finance/trial-balance">Trial balance →</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Income</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--ok)" }}>{m(pnl.income)}</div></div>
        <div className="card stat"><div className="k">Expense</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--warn)" }}>{m(pnl.expense)}</div></div>
        <div className="card stat"><div className="k">Net {Number(pnl.net_profit) >= 0 ? "profit" : "loss"}</div><div className="v" style={{ fontSize: "1.4rem", color: Number(pnl.net_profit) >= 0 ? "var(--ok)" : "var(--danger)" }}>{m(pnl.net_profit)}</div></div>
      </div>

      <Section title="Income" rows={incomeRows} side="income" total={pnl.income} />
      <Section title="Expense" rows={expenseRows} side="expense" total={pnl.expense} />
    </div>
  );
}
