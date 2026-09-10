/**
 * Supplier bill detail (§8.3): lines + post-to-ledger (Dr expense, Cr payable).
 * Atomic RPC; journal linked back. Company-scoped, graceful.
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
import { postBill, settleBill } from "../actions";

export const metadata = { title: "Bill — Singha Central" };

export default async function BillDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const { data: bill } = await db
    .from("supplier_bills")
    .select("id, bill_number, currency, total_amount, amount_settled, status, journal_id, suppliers(name)")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!bill) notFound();

  const outstanding = remaining(String(bill.total_amount ?? 0), String(bill.amount_settled ?? 0), bill.currency);
  const settled = settlementStatus(String(bill.total_amount ?? 0), String(bill.amount_settled ?? 0), bill.currency) === "paid";

  const [{ data: lines }, { data: accounts }] = await Promise.all([
    db.from("supplier_bill_lines").select("description, quantity, unit_price, amount").eq("bill_id", bill.id).eq("company_id", p.companyId),
    db.from("chart_of_accounts").select("code, name, type").eq("company_id", p.companyId).eq("is_active", true).order("code"),
  ]);
  const expenses = (accounts ?? []).filter((a: any) => a.type === "expense");
  const payables = (accounts ?? []).filter((a: any) => a.type === "liability");
  const assets = (accounts ?? []).filter((a: any) => a.type === "asset");

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
          <h1 className="mono">{bill.bill_number}</h1>
          <p className="muted mt-1">
            {(bill as any).suppliers?.name ?? "Supplier"} · <StatusBadge status={bill.status} /> · {fmtMoney(bill.total_amount, bill.currency)}
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/supplier-bills">← Bills</Link>
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
          {bill.journal_id ? (
            <p className="card-sub mt-1">
              ✅ Posted. <Link href={`/app/finance/journals/${bill.journal_id}`}>View journal →</Link>
            </p>
          ) : expenses.length === 0 || payables.length === 0 ? (
            <EmptyState
              title="Add accounts first"
              description="Add an expense and a liability (payable) account in Chart of Accounts first."
              action={{ label: "Chart of Accounts", href: "/app/finance/chart-of-accounts" }}
            />
          ) : (
            <form action={postBill} className="row gap-1 wrap items-end">
              <input type="hidden" name="bill_id" value={bill.id} />
              <label className="small dim">Dr Expense
                <select name="expense_code" className="select" style={{ width: 200 }}>
                  {expenses.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <label className="small dim">Cr Payable
                <select name="payable_code" className="select" style={{ width: 200 }}>
                  {payables.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
              <Button type="submit">Post {fmtMoney(bill.total_amount, bill.currency)}</Button>
            </form>
          )}
        </CardBody>
      </Card>

      {bill.journal_id && (
        <Card>
          <CardHeader
            title={
              <>
                Record payment <span className="dim small">(recording only — not a bank transfer)</span>
              </>
            }
          />
          <CardBody>
            <p className="card-sub mt-1">Outstanding: {fmtMoney(outstanding, bill.currency)}</p>
            {settled ? (
              <EmptyState title="Fully settled" icon="check" description="No outstanding balance on this bill." />
            ) : payables.length < 1 || expenses.length < 1 ? (
              <EmptyState
                title="Add payable and cash accounts first"
                description="Add a payable (liability) and a cash (asset) account first."
                action={{ label: "Chart of Accounts", href: "/app/finance/chart-of-accounts" }}
              />
            ) : (
              <form action={settleBill} className="row gap-1 wrap items-end">
                <input type="hidden" name="bill_id" value={bill.id} />
                <input name="amount" className="input" style={{ width: 130 }} placeholder="Amount" inputMode="decimal" defaultValue={outstanding} />
                <label className="small dim">Dr Payable
                  <select name="ap_code" className="select" style={{ width: 180 }}>
                    {payables.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                  </select>
                </label>
                <label className="small dim">Cr Cash
                  <select name="cash_code" className="select" style={{ width: 180 }}>
                    {assets.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                  </select>
                </label>
                <Button type="submit">Record payment</Button>
              </form>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
