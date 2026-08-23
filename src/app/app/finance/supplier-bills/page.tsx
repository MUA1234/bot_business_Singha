/**
 * Finance → Supplier Bills (AP, §8.3). Record bills, then post to the ledger from the
 * detail page. Posting is not payment. Company-scoped, audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  StatusBadge,
  DataTable,
  type DataTableColumn,
  Button,
} from "@/components/ui";
import { createBill } from "./actions";

export const metadata = { title: "Supplier Bills — Singha Central" };

export default async function SupplierBillsPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("supplier_bills")
      .select("id, bill_number, currency, total_amount, status, journal_id, due_date, suppliers(name)")
      .eq("company_id", p.companyId)
      .order("issue_date", { ascending: false })
      .limit(200);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<any>[] = [
    { key: "number", header: "Number", render: (r) => <span className="mono">{r.bill_number ?? "—"}</span> },
    { key: "supplier", header: "Supplier", render: (r) => r.suppliers?.name ?? "—" },
    { key: "total", header: "Total", align: "right", render: (r) => fmtMoney(r.total_amount, r.currency) },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "posted",
      header: "Posted",
      render: (r) =>
        r.journal_id ? <Badge variant="ok">ledger</Badge> : <Badge variant="warn">draft</Badge>,
    },
    {
      key: "action",
      header: "",
      render: (r) => (
        <Link className="btn ghost sm" href={`/app/finance/supplier-bills/${r.id}`}>
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Supplier Bills</h1>
        <p className="muted mt-1">Record bills, then post to the ledger (Dr expense, Cr payable). Posting ≠ payment.</p>
      </div>

      <Card>
        <CardHeader title="New bill" />
        <CardBody>
          <form action={createBill} className="row gap-1 wrap">
            <input name="supplier_name" className="input" style={{ minWidth: 160, flex: 1 }} placeholder="Supplier" required />
            <input name="description" className="input" style={{ minWidth: 160, flex: 2 }} placeholder="What for" required />
            <input name="quantity" className="input" style={{ width: 80 }} placeholder="Qty" inputMode="decimal" defaultValue="1" />
            <input name="unit_price" className="input" style={{ width: 120 }} placeholder="Unit price" inputMode="decimal" />
            <label className="small dim">Due <input name="due_date" type="date" className="input" style={{ width: 150 }} /></label>
            <Button type="submit">Create</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Bills (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No bills yet"
            className="mt-3"
          />
        </CardBody>
      </Card>
    </div>
  );
}
