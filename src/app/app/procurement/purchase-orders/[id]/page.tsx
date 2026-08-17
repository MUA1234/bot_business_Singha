/**
 * Purchase Order detail (§9.2): lines, goods receipt, and a live three-way-match
 * check of a supplier bill against the PO and what was received. Company-scoped +
 * audited writes; graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { addPoLine, recordLineReceipt } from "../actions";
import { ThreeWayCheck } from "./ThreeWayCheck";

export const metadata = { title: "Purchase Order — Singha" };

export default async function PurchaseOrderDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("procurement");
  const db = supabaseReadClient();

  const { data: po } = await db
    .from("purchase_orders")
    .select("id, po_number, total_amount, currency, status")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!po) notFound();

  const { data: lines } = await db
    .from("po_lines")
    .select("id, description, quantity, unit_price, received_quantity")
    .eq("purchase_order_id", po.id)
    .eq("company_id", p.companyId)
    .order("description");

  const rows = lines ?? [];
  const poQty = rows.reduce((s: number, l: any) => s + Number(l.quantity ?? 0), 0);
  const receivedQty = rows.reduce((s: number, l: any) => s + Number(l.received_quantity ?? 0), 0);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1 className="mono">{po.po_number}</h1>
          <p className="muted mt-1"><span className="badge">{(po.status ?? "").replace(/_/g, " ")}</span> · {fmtMoney(po.total_amount, po.currency)}</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement/purchase-orders">← All POs</Link>
      </div>

      <div className="card">
        <div className="card-title">Lines</div>
        {rows.length === 0 ? (
          <div className="empty">No lines yet. Add one below.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Received</th><th>Receive</th></tr></thead>
              <tbody>
                {rows.map((l: any) => {
                  const over = Number(l.received_quantity) > Number(l.quantity);
                  const full = Number(l.received_quantity) >= Number(l.quantity) && Number(l.quantity) > 0;
                  return (
                    <tr key={l.id}>
                      <td>{l.description}</td>
                      <td className="num">{Number(l.quantity)}</td>
                      <td className="num">{fmtMoney(l.unit_price)}</td>
                      <td className="num">
                        <span className={`badge ${over ? "danger" : full ? "ok" : "warn"}`}>{Number(l.received_quantity)}</span>
                      </td>
                      <td>
                        <form action={recordLineReceipt} className="row gap-1">
                          <input type="hidden" name="po_id" value={po.id} />
                          <input type="hidden" name="line_id" value={l.id} />
                          <input name="received" className="input" style={{ width: 80, padding: "6px 8px" }} placeholder="qty" inputMode="decimal" />
                          <button className="btn ghost sm" type="submit">Save</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <form action={addPoLine} className="row gap-1 wrap mt-3">
          <input type="hidden" name="po_id" value={po.id} />
          <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Line item" required />
          <input name="quantity" className="input" style={{ width: 90 }} placeholder="Qty" inputMode="decimal" />
          <input name="unit_price" className="input" style={{ width: 120 }} placeholder="Unit price" inputMode="decimal" />
          <button className="btn ghost sm" type="submit">Add line</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Bill check (three-way match)</div>
        <p className="card-sub mt-1">PO qty {poQty} · received {receivedQty} · PO total {fmtMoney(po.total_amount, po.currency)}</p>
        <div className="mt-2">
          <ThreeWayCheck currency={po.currency} poQuantity={poQty} poAmount={String(po.total_amount ?? 0)} receivedQuantity={receivedQty} />
        </div>
      </div>
    </div>
  );
}
