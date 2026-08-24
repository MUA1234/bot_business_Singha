"use client";

import Link from "next/link";
import { createPurchaseOrder } from "@/app/app/procurement/purchase-orders/actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtMoney } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { type PlainObject } from "./PurchaseOrdersPanel";

interface PurchaseOrderRow {
  id: string;
  po_number: string;
  total_amount: string;
  currency: string;
  status: string;
  expected_payment_date: string | null;
  created_at: string;
}

interface PurchaseOrdersPanelData {
  rows: PurchaseOrderRow[];
  suppliers: { id: string; name: string }[];
}

export function PurchaseOrdersPanelContent({ data, embedded }: { data: PlainObject; embedded?: boolean }) {
  const { rows, suppliers } = data as unknown as PurchaseOrdersPanelData;

  const columns: DataTableColumn<PurchaseOrderRow>[] = [
    {
      key: "poNumber",
      header: "PO number",
      render: (r) => <span className="mono" style={{ fontWeight: 600 }}>{r.po_number}</span>,
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      render: (r) => fmtMoney(r.total_amount, r.currency ?? "LKR"),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge>{(r.status ?? "").replace(/_/g, " ")}</Badge>,
    },
    {
      key: "expectedPayment",
      header: "Expected payment",
      render: (r) => r.expected_payment_date ? fmtDate(r.expected_payment_date) : <span className="dim">—</span>,
    },
    {
      key: "open",
      header: "",
      render: (r) => <Link className="btn ghost sm" href={`/app/procurement/purchase-orders/${r.id}`}>Open</Link>,
    },
  ];

  return (
    <div className="stack gap-3">
      {!embedded && (
        <div>
          <h1>Purchase Orders</h1>
          <p className="muted mt-1">Raise POs, receive goods, and check bills against them.</p>
        </div>
      )}

      <Card>
        <CardHeader title="New purchase order" />
        <CardBody>
          <form action={createPurchaseOrder} className="row gap-1 wrap mt-2">
            <input name="title" className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Reference / what it's for" />
            <select name="supplier_id" className="select" style={{ minWidth: 200 }}>
              <option value="">No supplier (internal)</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button className="btn" type="submit">Create PO</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`All POs (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No purchase orders yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
