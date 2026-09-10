/**
 * Finance → Expense Claims (§8.3). Review staff claims, approve/reject, and reimburse
 * approved ones (Dr Expense, Cr Cash via the atomic RPC). Recording only, not a bank
 * transfer. Company-scoped + audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import {
  Card,
  CardHeader,
  CardBody,
  StatusBadge,
  DataTable,
  type DataTableColumn,
  Button,
} from "@/components/ui";
import { decideExpense, reimburseExpense } from "./actions";

export const metadata = { title: "Expense Claims — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function ExpensesPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [claims, accounts] = await Promise.all([
    safe<any>(() => db.from("expense_claims").select("id, currency, amount, purpose, status, created_at, employees(name)").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200) as any),
    safe<any>(() => db.from("chart_of_accounts").select("code, name, type").eq("company_id", p.companyId).eq("is_active", true).order("code") as any),
  ]);
  const expenses = accounts.filter((a) => a.type === "expense");
  const assets = accounts.filter((a) => a.type === "asset");

  const columns: DataTableColumn<any>[] = [
    { key: "employee", header: "Employee", render: (c) => <span style={{ fontWeight: 600 }}>{c.employees?.name ?? "—"}</span> },
    { key: "purpose", header: "Purpose", render: (c) => c.purpose },
    { key: "amount", header: "Amount", align: "right", render: (c) => fmtMoney(c.amount, c.currency) },
    { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
    {
      key: "action",
      header: "Action",
      render: (c) => (
        <>
          {c.status === "submitted" && (
            <div className="row gap-1 wrap">
              <form action={decideExpense}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="decision" value="approved" />
                <Button variant="ghost" size="sm" type="submit">Approve</Button>
              </form>
              <form action={decideExpense}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="decision" value="rejected" />
                <Button variant="danger" size="sm" type="submit">Reject</Button>
              </form>
            </div>
          )}
          {c.status === "approved" && (expenses.length && assets.length ? (
            <form action={reimburseExpense} className="row gap-1 wrap items-end">
              <input type="hidden" name="id" value={c.id} />
              <select name="expense_code" className="select" style={{ width: 140, padding: "6px 8px" }}>{expenses.map((a: any) => <option key={a.code} value={a.code}>{a.code}</option>)}</select>
              <select name="cash_code" className="select" style={{ width: 140, padding: "6px 8px" }}>{assets.map((a: any) => <option key={a.code} value={a.code}>{a.code}</option>)}</select>
              <Button size="sm" type="submit">Reimburse</Button>
            </form>
          ) : <span className="small dim">add expense + cash accounts</span>)}
        </>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div><h1>Expense Claims</h1><p className="muted mt-1">Approve and reimburse staff expenses. Posting is not a bank transfer.</p></div>

      <Card>
        <CardHeader title={`Claims (${claims.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={claims}
            keyExtractor={(c) => c.id}
            emptyTitle="No expense claims"
            emptyDescription="Staff submit them from “My Work”."
            className="mt-3"
          />
        </CardBody>
      </Card>
    </div>
  );
}
