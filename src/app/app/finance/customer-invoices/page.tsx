/**
 * Finance → Customer Invoices (AR, §8.3). Create draft invoices; post them to the
 * ledger from the detail page. Company-scoped, audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { createInvoice } from "./actions";

export const metadata = { title: "Customer Invoices — Singha" };

export default async function CustomerInvoicesPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("customer_invoices")
      .select("id, invoice_number, currency, total_amount, amount_settled, status, journal_id, due_date, customers(name)")
      .eq("company_id", p.companyId)
      .order("issue_date", { ascending: false })
      .limit(200);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Customer Invoices</h1>
        <p className="muted mt-1">Bill customers, then post to the ledger (Dr receivable, Cr income).</p>
      </div>

      <div className="card">
        <div className="card-title">New invoice</div>
        <form action={createInvoice} className="row gap-1 wrap mt-2">
          <input name="customer_name" className="input" style={{ width: 160 }} placeholder="Customer" required />
          <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Item / service" required />
          <input name="quantity" className="input" style={{ width: 80 }} placeholder="Qty" inputMode="decimal" defaultValue="1" />
          <input name="unit_price" className="input" style={{ width: 120 }} placeholder="Unit price" inputMode="decimal" />
          <label className="small dim">Due <input name="due_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Invoices ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No invoices yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Number</th><th>Customer</th><th className="num">Total</th><th>Status</th><th>Posted</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.invoice_number}</td>
                    <td>{r.customers?.name ?? "—"}</td>
                    <td className="num">{fmtMoney(r.total_amount, r.currency)}</td>
                    <td><span className="badge">{r.status}</span></td>
                    <td>{r.journal_id ? <span className="badge ok">ledger</span> : <span className="badge warn">draft</span>}</td>
                    <td><Link className="btn ghost sm" href={`/app/finance/customer-invoices/${r.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
