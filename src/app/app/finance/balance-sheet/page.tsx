/**
 * Finance → Balance Sheet (§8.1). Assets vs liabilities + equity (with the period's
 * retained profit), derived purely from posted journals. Read-only, company-scoped.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { loadPostedJournals } from "@/lib/ledger-report";
import { decSub, fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, EmptyState } from "@/components/ui";
import { trialBalance, balanceSheet } from "@/accounting/trial-balance";

export const metadata = { title: "Balance Sheet — Singha Central" };

export default async function BalanceSheetPage() {
  const p = await requireDepartment("finance");
  const { journals, currency } = await loadPostedJournals(p.companyId);
  const tb = trialBalance(journals, currency);
  const bs = balanceSheet(tb);
  const m = (v: string) => fmtMoney(v, currency);

  const assetRows = tb.rows.filter((r) => r.account_type === "asset");
  const liabRows = tb.rows.filter((r) => r.account_type === "liability");
  const equityRows = tb.rows.filter((r) => r.account_type === "equity");
  const amt = (r: { debit: string; credit: string }, normal: "debit" | "credit") =>
    normal === "debit" ? decSub(r.debit, r.credit).toFixed() : decSub(r.credit, r.debit).toFixed();

  const Section = ({ title, rows, normal }: { title: string; rows: typeof tb.rows; normal: "debit" | "credit" }) => (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        {rows.length === 0 ? (
          <EmptyState title="Nothing posted" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>{rows.map((r) => <tr key={r.account_code}><td className="mono">{r.account_code}</td><td className="num">{m(amt(r, normal))}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Balance Sheet</h1><p className="muted mt-1">{bs.balances ? "A = L + E balances." : "Out of balance — check postings."}</p></div>
        <Link className="btn ghost sm" href="/app/finance/pnl">P&amp;L →</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Assets</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(bs.assets)}</div></div>
        <div className="card stat"><div className="k">Liabilities</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(bs.liabilities)}</div></div>
        <div className="card stat"><div className="k">Equity (incl. profit)</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(bs.equity)}</div></div>
      </div>

      {!bs.balances && <div className="notice err">⚠️ Assets ≠ Liabilities + Equity. Review recent postings/reversals.</div>}

      <Section title="Assets" rows={assetRows} normal="debit" />
      <Section title="Liabilities" rows={liabRows} normal="credit" />
      <Section title="Equity" rows={equityRows} normal="credit" />
    </div>
  );
}
