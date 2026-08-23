/**
 * Procurement → Purchase Orders. Company-scoped create + list (audited). Graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { createPurchaseOrder } from "./actions";

export const metadata = { title: "Purchase Orders — Singha Central" };

export default async function PurchaseOrdersPage() {
  const p = await requireDepartment("procurement");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("purchase_orders")
      .select("id, po_number, total_amount, currency, status, expected_payment_date, created_at")
      .eq("company_id", p.companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Purchase Orders</h1>
        <p className="muted mt-1">Raise POs, receive goods, and check bills against them.</p>
      </div>

      <div className="card">
        <div className="card-title">New purchase order</div>
        <form action={createPurchaseOrder} className="row gap-1 wrap mt-2">
          <input name="title" className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Reference / what it's for" />
          <button className="btn" type="submit">Create PO</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All POs ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No purchase orders yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>PO number</th><th className="num">Total</th><th>Status</th><th>Expected payment</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.po_number}</td>
                    <td className="num">{fmtMoney(r.total_amount, r.currency ?? "LKR")}</td>
                    <td><span className="badge">{(r.status ?? "").replace(/_/g, " ")}</span></td>
                    <td>{r.expected_payment_date ?? <span className="dim">—</span>}</td>
                    <td><Link className="btn ghost sm" href={`/app/procurement/purchase-orders/${r.id}`}>Open</Link></td>
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
