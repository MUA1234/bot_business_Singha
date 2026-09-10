/**
 * Finance → Customer Invoices (AR, §8.3). Create draft invoices; post them to the
 * ledger from the detail page. Company-scoped, audited, graceful.
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
import { createInvoice } from "./actions";

export const metadata = { title: "Customer Invoices — Singha Central" };

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

  const columns: DataTableColumn<any>[] = [
    { key: "number", header: "Number", render: (r) => <span className="mono">{r.invoice_number}</span> },
    { key: "customer", header: "Customer", render: (r) => r.customers?.name ?? "—" },
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
        <Link className="btn ghost sm" href={`/app/finance/customer-invoices/${r.id}`}>
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Customer Invoices</h1>
        <p className="muted mt-1">Bill customers, then post to the ledger (Dr receivable, Cr income).</p>
      </div>

      <Card>
        <CardHeader title="New invoice" />
        <CardBody>
          <form action={createInvoice} className="row gap-1 wrap">
            <input name="customer_name" className="input" style={{ minWidth: 160, flex: 1 }} placeholder="Customer" required />
            <input name="description" className="input" style={{ minWidth: 160, flex: 2 }} placeholder="Item / service" required />
            <input name="quantity" className="input" style={{ width: 80 }} placeholder="Qty" inputMode="decimal" defaultValue="1" />
            <input name="unit_price" className="input" style={{ width: 120 }} placeholder="Unit price" inputMode="decimal" />
            <label className="small dim">Due <input name="due_date" type="date" className="input" style={{ width: 150 }} /></label>
            <Button type="submit">Create</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Invoices (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No invoices yet"
            className="mt-3"
          />
        </CardBody>
      </Card>
    </div>
  );
}
