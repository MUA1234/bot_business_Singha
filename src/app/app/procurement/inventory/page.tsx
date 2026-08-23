/**
 * Procurement → Inventory (§9.2). Items with quantity, reorder level and stock
 * movements; reorder flags + total valuation via the pure engine. Company-scoped +
 * audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { needsReorder, reorderList, stockValuation, type StockItem } from "@/modules/procurement/inventory";
import { createItem, moveStock } from "./actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "Inventory — Singha Central" };

interface InventoryRow {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  quantity_on_hand: number;
  reorder_level: number;
  unit_cost: string;
  currency: string;
}

export default async function InventoryPage() {
  const p = await requireDepartment("procurement");

  let rawRows: any[] = [];
  try {
    rawRows = (await supabaseReadClient().from("inventory_items").select("id, name, sku, unit, quantity_on_hand, reorder_level, unit_cost, currency").eq("company_id", p.companyId).order("name").limit(500)).data ?? [];
  } catch {
    rawRows = [];
  }

  const currency = rawRows[0]?.currency ?? "LKR";
  const items: StockItem[] = rawRows.map((r) => ({ name: r.name, quantityOnHand: Number(r.quantity_on_hand ?? 0), reorderLevel: Number(r.reorder_level ?? 0), unitCost: String(r.unit_cost ?? 0) }));
  const reorder = reorderList(items).length;
  const valuation = stockValuation(items, currency);

  const rows: InventoryRow[] = rawRows.map((r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku ?? null,
    unit: r.unit ?? null,
    quantity_on_hand: Number(r.quantity_on_hand ?? 0),
    reorder_level: Number(r.reorder_level ?? 0),
    unit_cost: String(r.unit_cost ?? 0),
    currency: r.currency ?? currency,
  }));

  const columns: DataTableColumn<InventoryRow>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.name}</div>
          <div className="small dim mono">{r.sku ?? ""}</div>
        </div>
      ),
    },
    {
      key: "onHand",
      header: "On hand",
      align: "right",
      render: (r) => {
        const low = needsReorder({ quantityOnHand: r.quantity_on_hand, reorderLevel: r.reorder_level });
        return low ? <Badge variant="danger">{fmtNumber(r.quantity_on_hand)} {r.unit ?? ""}</Badge> : `${fmtNumber(r.quantity_on_hand)} ${r.unit ?? ""}`;
      },
    },
    {
      key: "reorder",
      header: "Reorder",
      align: "right",
      className: "dim",
      render: (r) => fmtNumber(r.reorder_level),
    },
    {
      key: "unitCost",
      header: "Unit cost",
      align: "right",
      render: (r) => fmtMoney(r.unit_cost, r.currency),
    },
    {
      key: "move",
      header: "Move stock",
      render: (r) => (
        <form action={moveStock} className="row gap-1">
          <input type="hidden" name="item_id" value={r.id} />
          <select name="direction" className="select" style={{ width: 90, padding: "6px 8px" }} defaultValue="in"><option value="in">in</option><option value="out">out</option><option value="adjust">set</option></select>
          <input name="quantity" className="input" style={{ width: 70, padding: "6px 8px" }} placeholder="qty" inputMode="decimal" />
          <button className="btn ghost sm" type="submit">Apply</button>
        </form>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div><h1>Inventory</h1><p className="muted mt-1">Stock on hand, reorder points and valuation.</p></div>

      <div className="grid cols-2">
        <div className="card stat"><div className="k">Stock valuation</div><div className="v" style={{ fontSize: "1.5rem" }}>{fmtMoney(valuation, currency)}</div></div>
        <div className="card stat"><div className="k">Below reorder</div><div className="v" style={{ fontSize: "1.5rem", color: reorder ? "var(--danger)" : "var(--ok)" }}>{reorder}</div></div>
      </div>

      <Card>
        <CardHeader title="New item" />
        <CardBody>
          <form action={createItem} className="row gap-1 wrap mt-2">
            <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Item name" required />
            <input name="sku" className="input" style={{ width: 110 }} placeholder="SKU" />
            <input name="unit" className="input" style={{ width: 80 }} placeholder="Unit" />
            <input name="quantity_on_hand" className="input" style={{ width: 90 }} placeholder="Qty" inputMode="decimal" />
            <input name="reorder_level" className="input" style={{ width: 100 }} placeholder="Reorder @" inputMode="decimal" />
            <input name="unit_cost" className="input" style={{ width: 100 }} placeholder="Unit cost" inputMode="decimal" />
            <button className="btn" type="submit">Add</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Items (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No inventory items yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
