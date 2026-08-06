/**
 * Supplier bill detail (§8.3): lines + post-to-ledger (Dr expense, Cr payable).
 * Atomic RPC; journal linked back. Company-scoped, graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { remaining, settlementStatus } from "@/accounting/settlement";
import { postBill, settleBill } from "../actions";

export const metadata = { title: "Bill — Singha" };

export default async function BillDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const { data: bill } = await db
    .from("supplier_bills")
    .select("id, bill_number, currency, total_amount, amount_settled, status, journal_id, suppliers(name)")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!bill) notFound();

  const outstanding = remaining(String(bill.total_amount ?? 0), String(bill.amount_settled ?? 0), bill.currency);
  const settled = settlementStatus(String(bill.total_amount ?? 0), String(bill.amount_settled ?? 0), bill.currency) === "paid";

  const [{ data: lines }, { data: accounts }] = await Promise.all([
    db.from("supplier_bill_lines").select("description, quantity, unit_price, amount").eq("bill_id", bill.id).eq("company_id", p.companyId),
    db.from("chart_of_accounts").select("code, name, type").eq("company_id", p.companyId).eq("is_active", true).order("code"),
  ]);
  const expenses = (accounts ?? []).filter((a: any) => a.type === "expense");
  const payables = (accounts ?? []).filter((a: any) => a.type === "liability");
  const assets = (accounts ?? []).filter((a: any) => a.type === "asset");

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1 className="mono">{bill.bill_number}</h1>
          <p className="muted mt-1">{(bill as any).suppliers?.name ?? "Supplier"} · <span className="badge">{bill.status}</span> · {bill.currency} {Number(bill.total_amount ?? 0).toLocaleString()}</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/supplier-bills">← Bills</Link>
      </div>

      <div className="card">
        <div className="card-title">Lines</div>
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {(lines ?? []).map((l: any, i: number) => (
                <tr key={i}><td>{l.description}</td><td className="num">{Number(l.quantity)}</td><td className="num">{Number(l.unit_price).toLocaleString()}</td><td className="num">{Number(l.amount).toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Post to ledger</div>
        {bill.journal_id ? (
          <p className="card-sub mt-1">✅ Posted. <Link href={`/app/finance/journals/${bill.journal_id}`}>View journal →</Link></p>
        ) : expenses.length === 0 || payables.length === 0 ? (
          <div className="empty">Add an expense and a liability (payable) account in <Link href="/app/finance/chart-of-accounts">Chart of Accounts</Link> first.</div>
        ) : (
          <form action={postBill} className="row gap-1 wrap mt-2">
            <input type="hidden" name="bill_id" value={bill.id} />
            <label className="small dim">Dr Expense
              <select name="expense_code" className="select" style={{ width: 200 }}>
                {expenses.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </label>
            <label className="small dim">Cr Payable
              <select name="payable_code" className="select" style={{ width: 200 }}>
                {payables.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </label>
            <button className="btn" type="submit">Post {bill.currency} {Number(bill.total_amount ?? 0).toLocaleString()}</button>
          </form>
        )}
      </div>

      {bill.journal_id && (
        <div className="card">
          <div className="card-title">Record payment <span className="dim small">(recording only — not a bank transfer)</span></div>
          <p className="card-sub mt-1">Outstanding: {bill.currency} {Number(outstanding).toLocaleString()}</p>
          {settled ? (
            <div className="empty">Fully settled. ✅</div>
          ) : payables.length < 1 || expenses.length < 1 ? (
            <div className="empty">Add a payable (liability) and a cash (asset) account first.</div>
          ) : (
            <form action={settleBill} className="row gap-1 wrap mt-2">
              <input type="hidden" name="bill_id" value={bill.id} />
              <input name="amount" className="input" style={{ width: 130 }} placeholder="Amount" inputMode="decimal" defaultValue={outstanding} />
              <label className="small dim">Dr Payable
                <select name="ap_code" className="select" style={{ width: 180 }}>
                  {payables.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <label className="small dim">Cr Cash
                <select name="cash_code" className="select" style={{ width: 180 }}>
                  {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <button className="btn" type="submit">Record payment</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
