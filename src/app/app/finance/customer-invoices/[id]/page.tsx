/**
 * Customer invoice detail (§8.3): lines + post-to-ledger (Dr receivable, Cr income).
 * Posting uses the atomic RPC; the resulting journal is linked back. Company-scoped.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { remaining, settlementStatus } from "@/accounting/settlement";
import { fmtMoney } from "@/lib/money";
import { fmtNumber } from "@/lib/format";
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  StatusBadge,
  EmptyState,
  DataTable,
  type DataTableColumn,
  Button,
} from "@/components/ui";
import { postInvoice, settleInvoice } from "../actions";

export const metadata = { title: "Invoice — Singha Central" };

export default async function InvoiceDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const { data: inv } = await db
    .from("customer_invoices")
    .select("id, invoice_number, currency, total_amount, amount_settled, status, journal_id, due_date, customers(name)")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!inv) notFound();

  const outstanding = remaining(String(inv.total_amount ?? 0), String(inv.amount_settled ?? 0), inv.currency);
  const paid = settlementStatus(String(inv.total_amount ?? 0), String(inv.amount_settled ?? 0), inv.currency) === "paid";

  const [{ data: lines }, { data: accounts }] = await Promise.all([
    db.from("customer_invoice_lines").select("description, quantity, unit_price, amount").eq("invoice_id", inv.id).eq("company_id", p.companyId),
    db.from("chart_of_accounts").select("code, name, type").eq("company_id", p.companyId).eq("is_active", true).order("code"),
  ]);
  const assets = (accounts ?? []).filter((a: any) => a.type === "asset");
  const incomes = (accounts ?? []).filter((a: any) => a.type === "income");

  const lineRows = (lines ?? []).map((l, i) => ({ ...l, _key: i }));
  const lineColumns: DataTableColumn<any>[] = [
    { key: "description", header: "Description", render: (l) => l.description },
    { key: "quantity", header: "Qty", align: "right", render: (l) => fmtNumber(l.quantity) },
    { key: "unit", header: "Unit", align: "right", render: (l) => fmtMoney(l.unit_price) },
    { key: "amount", header: "Amount", align: "right", render: (l) => fmtMoney(l.amount) },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1 className="mono">{inv.invoice_number}</h1>
          <p className="muted mt-1">
            {(inv as any).customers?.name ?? "Customer"} · <StatusBadge status={inv.status} /> · {fmtMoney(inv.total_amount, inv.currency)}
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/customer-invoices">← Invoices</Link>
      </div>

      <Card>
        <CardHeader title="Lines" />
        <CardBody>
          <DataTable
            columns={lineColumns}
            rows={lineRows}
            keyExtractor={(l) => l._key}
            emptyTitle="No lines"
            className="mt-3"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Post to ledger" />
        <CardBody>
          {inv.journal_id ? (
            <p className="card-sub mt-1">
              ✅ Posted. <Link href={`/app/finance/journals/${inv.journal_id}`}>View journal →</Link>
            </p>
          ) : assets.length === 0 || incomes.length === 0 ? (
            <EmptyState
              title="Add accounts first"
              description="Add an asset (receivable) and an income account in Chart of Accounts first."
              action={{ label: "Chart of Accounts", href: "/app/finance/chart-of-accounts" }}
            />
          ) : (
            <form action={postInvoice} className="row gap-1 wrap items-end">
              <input type="hidden" name="invoice_id" value={inv.id} />
              <label className="small dim">Dr Receivable
                <select name="receivable_code" className="select" style={{ width: 200 }}>
                  {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <label className="small dim">Cr Income
                <select name="income_code" className="select" style={{ width: 200 }}>
                  {incomes.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <Button type="submit">Post {fmtMoney(inv.total_amount, inv.currency)}</Button>
            </form>
          )}
        </CardBody>
      </Card>

      {inv.journal_id && (
        <Card>
          <CardHeader
            title={
              <>
                Record receipt <span className="dim small">(recording only — not a bank transfer)</span>
              </>
            }
          />
          <CardBody>
            <p className="card-sub mt-1">Outstanding: {fmtMoney(outstanding, inv.currency)}</p>
            {paid ? (
              <EmptyState title="Fully settled" icon="check" description="No outstanding balance on this invoice." />
            ) : assets.length < 1 ? (
              <EmptyState
                title="Add asset accounts first"
                description="Add asset accounts (cash + receivable) first."
                action={{ label: "Chart of Accounts", href: "/app/finance/chart-of-accounts" }}
              />
            ) : (
              <form action={settleInvoice} className="row gap-1 wrap items-end">
                <input type="hidden" name="invoice_id" value={inv.id} />
                <input name="amount" className="input" style={{ width: 130 }} placeholder="Amount" inputMode="decimal" defaultValue={outstanding} />
                <label className="small dim">Dr Cash
                  <select name="cash_code" className="select" style={{ width: 180 }}>
                    {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                  </select>
                </label>
                <label className="small dim">Cr Receivable
                  <select name="ar_code" className="select" style={{ width: 180 }}>
                    {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                  </select>
                </label>
                <Button type="submit">Record receipt</Button>
              </form>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
