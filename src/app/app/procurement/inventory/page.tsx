/**
 * Procurement → Inventory (§9.2). Items with quantity, reorder level and stock
 * movements; reorder flags + total valuation via the pure engine. Company-scoped +
 * audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { needsReorder, reorderList, stockValuation, type StockItem } from "@/modules/procurement/inventory";
import { createItem, moveStock } from "./actions";

export const metadata = { title: "Inventory — Singha" };

export default async function InventoryPage() {
  const p = await requireDepartment("procurement");

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("inventory_items").select("id, name, sku, unit, quantity_on_hand, reorder_level, unit_cost, currency").eq("company_id", p.companyId).order("name").limit(500)).data ?? [];
  } catch {
    rows = [];
  }

  const currency = rows[0]?.currency ?? "LKR";
  const items: StockItem[] = rows.map((r) => ({ name: r.name, quantityOnHand: Number(r.quantity_on_hand ?? 0), reorderLevel: Number(r.reorder_level ?? 0), unitCost: String(r.unit_cost ?? 0) }));
  const reorder = reorderList(items).length;
  const valuation = stockValuation(items, currency);

  return (
    <div className="stack gap-3">
      <div><h1>Inventory</h1><p className="muted mt-1">Stock on hand, reorder points and valuation.</p></div>

      <div className="grid cols-2">
        <div className="card stat"><div className="k">Stock valuation</div><div className="v" style={{ fontSize: "1.5rem" }}>{currency} {Number(valuation).toLocaleString()}</div></div>
        <div className="card stat"><div className="k">Below reorder</div><div className="v" style={{ fontSize: "1.5rem", color: reorder ? "var(--danger)" : "var(--ok)" }}>{reorder}</div></div>
      </div>

      <div className="card">
        <div className="card-title">New item</div>
        <form action={createItem} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Item name" required />
          <input name="sku" className="input" style={{ width: 110 }} placeholder="SKU" />
          <input name="unit" className="input" style={{ width: 80 }} placeholder="Unit" />
          <input name="quantity_on_hand" className="input" style={{ width: 90 }} placeholder="Qty" inputMode="decimal" />
          <input name="reorder_level" className="input" style={{ width: 100 }} placeholder="Reorder @" inputMode="decimal" />
          <input name="unit_cost" className="input" style={{ width: 100 }} placeholder="Unit cost" inputMode="decimal" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Items ({rows.length})</div>
        {rows.length === 0 ? <div className="empty">No inventory items yet.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Item</th><th className="num">On hand</th><th className="num">Reorder</th><th className="num">Unit cost</th><th>Move stock</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const low = needsReorder({ quantityOnHand: Number(r.quantity_on_hand ?? 0), reorderLevel: Number(r.reorder_level ?? 0) });
                  return (
                    <tr key={r.id}>
                      <td><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small dim mono">{r.sku ?? ""}</div></td>
                      <td className="num">{low ? <span className="badge danger">{Number(r.quantity_on_hand)} {r.unit ?? ""}</span> : `${Number(r.quantity_on_hand)} ${r.unit ?? ""}`}</td>
                      <td className="num dim">{Number(r.reorder_level)}</td>
                      <td className="num">{r.currency} {Number(r.unit_cost).toLocaleString()}</td>
                      <td>
                        <form action={moveStock} className="row gap-1">
                          <input type="hidden" name="item_id" value={r.id} />
                          <select name="direction" className="select" style={{ width: 90, padding: "6px 8px" }} defaultValue="in"><option value="in">in</option><option value="out">out</option><option value="adjust">set</option></select>
                          <input name="quantity" className="input" style={{ width: 70, padding: "6px 8px" }} placeholder="qty" inputMode="decimal" />
                          <button className="btn ghost sm" type="submit">Apply</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
