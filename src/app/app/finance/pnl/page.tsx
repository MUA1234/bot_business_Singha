/**
 * Finance → Profit & Loss (§8.1). Income less expense, per account, derived purely
 * from posted journals. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { loadPostedJournals } from "@/lib/ledger-report";
import { dec, decSub, fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, EmptyState } from "@/components/ui";
import { trialBalance, profitAndLoss } from "@/accounting/trial-balance";

export const metadata = { title: "Profit & Loss — Singha Central" };

export default async function PnlPage() {
  const p = await requireDepartment("finance");
  const { journals, currency } = await loadPostedJournals(p.companyId);
  const tb = trialBalance(journals, currency);
  const pnl = profitAndLoss(tb);
  const m = (v: string) => fmtMoney(v, currency);

  const incomeRows = tb.rows.filter((r) => r.account_type === "income");
  const expenseRows = tb.rows.filter((r) => r.account_type === "expense");
  const rowAmount = (r: { debit: string; credit: string }, side: "income" | "expense") =>
    side === "income" ? decSub(r.credit, r.debit).toFixed() : decSub(r.debit, r.credit).toFixed();

  const Section = ({ title, rows, side, total }: { title: string; rows: typeof tb.rows; side: "income" | "expense"; total: string }) => (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        {rows.length === 0 ? (
          <EmptyState title="Nothing posted" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.account_code}><td className="mono">{r.account_code}</td><td className="num">{m(rowAmount(r, side))}</td></tr>
                ))}
                <tr><td style={{ fontWeight: 700 }}>Total {title.toLowerCase()}</td><td className="num" style={{ fontWeight: 700 }}>{m(total)}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Profit &amp; Loss</h1><p className="muted mt-1">From posted journals. Net {dec(pnl.net_profit).isNegative() ? "loss" : "profit"}.</p></div>
        <Link className="btn ghost sm" href="/app/finance/trial-balance">Trial balance →</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Income</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--ok)" }}>{m(pnl.income)}</div></div>
        <div className="card stat"><div className="k">Expense</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--warn)" }}>{m(pnl.expense)}</div></div>
        <div className="card stat"><div className="k">Net {dec(pnl.net_profit).isNegative() ? "loss" : "profit"}</div><div className="v" style={{ fontSize: "1.4rem", color: dec(pnl.net_profit).isNegative() ? "var(--danger)" : "var(--ok)" }}>{m(pnl.net_profit)}</div></div>
      </div>

      <Section title="Income" rows={incomeRows} side="income" total={pnl.income} />
      <Section title="Expense" rows={expenseRows} side="expense" total={pnl.expense} />
    </div>
  );
}
