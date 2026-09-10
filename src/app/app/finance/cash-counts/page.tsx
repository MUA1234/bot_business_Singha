/**
 * Finance → Cash Counts (§8.3). Record a physical count of a cash account; the system
 * computes the book balance and stores the variance. Company-scoped + audited.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { dec, fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, Button, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { recordCashCount } from "./actions";

export const metadata = { title: "Cash Counts — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function CashCountsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const [accounts, counts] = await Promise.all([
    safe<any>(() => db.from("cash_accounts").select("id, name, currency").eq("company_id", p.companyId).order("name") as any),
    safe<any>(() => db.from("cash_counts").select("id, counted_amount, variance, counted_at, cash_accounts(name, currency)").eq("company_id", p.companyId).order("counted_at", { ascending: false }).limit(100) as any),
  ]);

  const columns: DataTableColumn<(typeof counts)[number]>[] = [
    { key: "account", header: "Account", render: (c) => <span style={{ fontWeight: 600 }}>{c.cash_accounts?.name ?? "—"}</span> },
    { key: "counted", header: "Counted", align: "right", render: (c) => fmtMoney(c.counted_amount, c.cash_accounts?.currency) },
    {
      key: "variance",
      header: "Variance",
      align: "right",
      render: (c) => {
        const v = dec(c.variance);
        return (
          <span style={{ color: v.isNegative() ? "var(--danger)" : v.greaterThan(0) ? "var(--warn)" : "var(--ok)" }}>
            {v.greaterThan(0) ? "+" : ""}{fmtMoney(v)}
          </span>
        );
      },
    },
    { key: "when", header: "When", render: (c) => <span className="dim small">{fmtDateTime(c.counted_at)}</span> },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Cash Counts</h1><p className="muted mt-1">Reconcile physical cash to the books.</p></div>
        <Link className="btn ghost sm" href="/app/finance/accounts">Bank & Cash →</Link>
      </div>

      <Card>
        <CardHeader title="Record a count" />
        <CardBody>
          {accounts.length === 0 ? (
            <EmptyState
              title="No cash account"
              description="Add a cash account before recording a count."
              action={{ label: "Bank & Cash", href: "/app/finance/accounts" }}
            />
          ) : (
            <form action={recordCashCount} className="row gap-1 wrap">
              <select name="cash_account_id" className="select" style={{ maxWidth: 260 }}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
              </select>
              <input name="counted_amount" className="input" style={{ flex: "0 0 140px", minWidth: 120 }} placeholder="Counted amount" inputMode="decimal" />
              <Button type="submit">Record</Button>
            </form>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`History (${counts.length})`} />
        <CardBody>
          <DataTable columns={columns} rows={counts} keyExtractor={(c) => c.id} emptyTitle="No counts yet" />
        </CardBody>
      </Card>
    </div>
  );
}
