/**
 * Finance → Balance Sheet (§8.1). Assets vs liabilities + equity (with the period's
 * retained profit), derived purely from posted journals. Read-only, company-scoped.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { loadPostedJournals } from "@/lib/ledger-report";
import { trialBalance, balanceSheet } from "@/accounting/trial-balance";

export const metadata = { title: "Balance Sheet — Singha" };

export default async function BalanceSheetPage() {
  const p = await requireDepartment("finance");
  const { journals, currency } = await loadPostedJournals(p.companyId);
  const tb = trialBalance(journals, currency);
  const bs = balanceSheet(tb);
  const m = (v: string) => `${currency} ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  const assetRows = tb.rows.filter((r) => r.account_type === "asset");
  const liabRows = tb.rows.filter((r) => r.account_type === "liability");
  const equityRows = tb.rows.filter((r) => r.account_type === "equity");
  const amt = (r: { debit: string; credit: string }, normal: "debit" | "credit") =>
    normal === "debit" ? Number(r.debit) - Number(r.credit) : Number(r.credit) - Number(r.debit);

  const Section = ({ title, rows, normal }: { title: string; rows: typeof tb.rows; normal: "debit" | "credit" }) => (
    <div className="card">
      <div className="card-title">{title}</div>
      {rows.length === 0 ? <div className="empty">Nothing posted.</div> : (
        <div className="table-wrap mt-3">
          <table className="data">
            <tbody>{rows.map((r) => <tr key={r.account_code}><td className="mono">{r.account_code}</td><td className="num">{m(String(amt(r, normal)))}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
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
