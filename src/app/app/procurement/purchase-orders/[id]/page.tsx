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
import { addPoLine, recordLineReceipt, updateExpectedPaymentDate } from "../actions";
import { ThreeWayCheck } from "./ThreeWayCheck";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata = { title: "Purchase Order — Singha Central" };

interface PoLineRow {
  id: string;
  description: string;
  quantity: number;
  unit_price: string;
  received_quantity: number;
}

export default async function PurchaseOrderDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("procurement");
  const db = supabaseReadClient();

  const { data: po } = await db
    .from("purchase_orders")
    .select("id, po_number, total_amount, currency, status, expected_payment_date")
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

  const rows: PoLineRow[] = (lines ?? []).map((l: any) => ({
    id: l.id,
    description: l.description,
    quantity: Number(l.quantity ?? 0),
    unit_price: String(l.unit_price ?? 0),
    received_quantity: Number(l.received_quantity ?? 0),
  }));
  const poQty = rows.reduce((s, l) => s + l.quantity, 0);
  const receivedQty = rows.reduce((s, l) => s + l.received_quantity, 0);

  const columns: DataTableColumn<PoLineRow>[] = [
    { key: "description", header: "Item", render: (l) => l.description },
    { key: "quantity", header: "Qty", align: "right", render: (l) => fmtNumber(l.quantity) },
    { key: "unit", header: "Unit", align: "right", render: (l) => fmtMoney(l.unit_price) },
    {
      key: "received",
      header: "Received",
      align: "right",
      render: (l) => {
        const over = l.received_quantity > l.quantity;
        const full = l.received_quantity >= l.quantity && l.quantity > 0;
        return <Badge variant={over ? "danger" : full ? "ok" : "warn"}>{fmtNumber(l.received_quantity)}</Badge>;
      },
    },
    {
      key: "receive",
      header: "Receive",
      render: (l) => (
        <form action={recordLineReceipt} className="row gap-1">
          <input type="hidden" name="po_id" value={po.id} />
          <input type="hidden" name="line_id" value={l.id} />
          <input name="received" className="input" style={{ width: 80, padding: "6px 8px" }} placeholder="qty" inputMode="decimal" />
          <button className="btn ghost sm" type="submit">Save</button>
        </form>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1 className="mono">{po.po_number}</h1>
          <p className="muted mt-1"><Badge>{(po.status ?? "").replace(/_/g, " ")}</Badge> · {fmtMoney(po.total_amount, po.currency)}</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement/purchase-orders">← All POs</Link>
      </div>

      <Card>
        <CardHeader title="Lines" />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(l) => l.id}
            emptyTitle="No lines yet"
            emptyDescription="Add a line below."
            className="mt-3"
          />
          <form action={addPoLine} className="row gap-1 wrap mt-3">
            <input type="hidden" name="po_id" value={po.id} />
            <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Line item" required />
            <input name="quantity" className="input" style={{ width: 90 }} placeholder="Qty" inputMode="decimal" />
            <input name="unit_price" className="input" style={{ width: 120 }} placeholder="Unit price" inputMode="decimal" />
            <button className="btn ghost sm" type="submit">Add line</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Bill check (three-way match)" />
        <CardBody>
          <p className="card-sub mt-1">PO qty {fmtNumber(poQty)} · received {fmtNumber(receivedQty)} · PO total {fmtMoney(po.total_amount, po.currency)}</p>
          <div className="mt-2">
            <ThreeWayCheck currency={po.currency} poQuantity={poQty} poAmount={String(po.total_amount ?? 0)} receivedQuantity={receivedQty} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Expected payment date" subtitle="When this PO is expected to be paid. Used in the Command Centre cash forecast." />
        <CardBody>
          <form action={updateExpectedPaymentDate} className="row gap-1 wrap mt-2">
            <input type="hidden" name="po_id" value={po.id} />
            <input
              type="date"
              name="expected_payment_date"
              className="input"
              defaultValue={po.expected_payment_date ?? ""}
              style={{ width: 180 }}
            />
            <button className="btn ghost sm" type="submit">Update</button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
