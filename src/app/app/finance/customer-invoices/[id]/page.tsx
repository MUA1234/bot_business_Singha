/**
 * Customer invoice detail (§8.3): lines + post-to-ledger (Dr receivable, Cr income).
 * Posting uses the atomic RPC; the resulting journal is linked back. Company-scoped.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { remaining, settlementStatus } from "@/accounting/settlement";
import { postInvoice, settleInvoice } from "../actions";

export const metadata = { title: "Invoice — Singha" };

export default async function InvoiceDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const { data: inv } = await db
    .from("customer_invoices")
    .select("id, invoice_number, currency, total_amount, amount_settled, status, journal_id, due_date, customers(name)")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!inv) notFound();

  const outstanding = remaining(String(inv.total_amount ?? 0), String(inv.amount_settled ?? 0), inv.currency);
  const paid = settlementStatus(String(inv.total_amount ?? 0), String(inv.amount_settled ?? 0), inv.currency) === "paid";

  const [{ data: lines }, { data: accounts }] = await Promise.all([
    db.from("customer_invoice_lines").select("description, quantity, unit_price, amount").eq("invoice_id", inv.id).eq("company_id", p.companyId),
    db.from("chart_of_accounts").select("code, name, type").eq("company_id", p.companyId).eq("is_active", true).order("code"),
  ]);
  const assets = (accounts ?? []).filter((a: any) => a.type === "asset");
  const incomes = (accounts ?? []).filter((a: any) => a.type === "income");

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1 className="mono">{inv.invoice_number}</h1>
          <p className="muted mt-1">{(inv as any).customers?.name ?? "Customer"} · <span className="badge">{inv.status}</span> · {inv.currency} {Number(inv.total_amount ?? 0).toLocaleString()}</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/customer-invoices">← Invoices</Link>
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
        {inv.journal_id ? (
          <p className="card-sub mt-1">✅ Posted. <Link href={`/app/finance/journals/${inv.journal_id}`}>View journal →</Link></p>
        ) : assets.length === 0 || incomes.length === 0 ? (
          <div className="empty">Add an asset (receivable) and an income account in <Link href="/app/finance/chart-of-accounts">Chart of Accounts</Link> first.</div>
        ) : (
          <form action={postInvoice} className="row gap-1 wrap mt-2">
            <input type="hidden" name="invoice_id" value={inv.id} />
            <label className="small dim">Dr Receivable
              <select name="receivable_code" className="select" style={{ width: 200 }}>
                {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </label>
            <label className="small dim">Cr Income
              <select name="income_code" className="select" style={{ width: 200 }}>
                {incomes.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </label>
            <button className="btn" type="submit">Post {inv.currency} {Number(inv.total_amount ?? 0).toLocaleString()}</button>
          </form>
        )}
      </div>

      {inv.journal_id && (
        <div className="card">
          <div className="card-title">Record receipt <span className="dim small">(recording only — not a bank transfer)</span></div>
          <p className="card-sub mt-1">Outstanding: {inv.currency} {Number(outstanding).toLocaleString()}</p>
          {paid ? (
            <div className="empty">Fully settled. ✅</div>
          ) : assets.length < 1 ? (
            <div className="empty">Add asset accounts (cash + receivable) first.</div>
          ) : (
            <form action={settleInvoice} className="row gap-1 wrap mt-2">
              <input type="hidden" name="invoice_id" value={inv.id} />
              <input name="amount" className="input" style={{ width: 130 }} placeholder="Amount" inputMode="decimal" defaultValue={outstanding} />
              <label className="small dim">Dr Cash
                <select name="cash_code" className="select" style={{ width: 180 }}>
                  {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <label className="small dim">Cr Receivable
                <select name="ar_code" className="select" style={{ width: 180 }}>
                  {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <button className="btn" type="submit">Record receipt</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
