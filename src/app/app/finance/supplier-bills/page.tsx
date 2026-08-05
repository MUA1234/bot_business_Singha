/**
 * Finance → Supplier Bills (AP, §8.3). Record bills, then post to the ledger from the
 * detail page. Posting is not payment. Company-scoped, audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createBill } from "./actions";

export const metadata = { title: "Supplier Bills — Singha" };

export default async function SupplierBillsPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    const { data } = await supabaseAdmin()
      .from("supplier_bills")
      .select("id, bill_number, currency, total_amount, status, journal_id, due_date, suppliers(name)")
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
        <h1>Supplier Bills</h1>
        <p className="muted mt-1">Record bills, then post to the ledger (Dr expense, Cr payable). Posting ≠ payment.</p>
      </div>

      <div className="card">
        <div className="card-title">New bill</div>
        <form action={createBill} className="row gap-1 wrap mt-2">
          <input name="supplier_name" className="input" style={{ width: 160 }} placeholder="Supplier" required />
          <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="What for" required />
          <input name="quantity" className="input" style={{ width: 80 }} placeholder="Qty" inputMode="decimal" defaultValue="1" />
          <input name="unit_price" className="input" style={{ width: 120 }} placeholder="Unit price" inputMode="decimal" />
          <label className="small dim">Due <input name="due_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Bills ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No bills yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Number</th><th>Supplier</th><th className="num">Total</th><th>Status</th><th>Posted</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.bill_number ?? "—"}</td>
                    <td>{r.suppliers?.name ?? "—"}</td>
                    <td className="num">{r.currency} {Number(r.total_amount ?? 0).toLocaleString()}</td>
                    <td><span className="badge">{r.status}</span></td>
                    <td>{r.journal_id ? <span className="badge ok">ledger</span> : <span className="badge warn">draft</span>}</td>
                    <td><Link className="btn ghost sm" href={`/app/finance/supplier-bills/${r.id}`}>Open</Link></td>
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
