/**
 * Finance → Commitments & Recurring (§8.5). Future outflows that the cash forecast
 * should account for beyond invoices/bills (rent, salaries, contracted spend).
 * Company-scoped + audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, Button, Badge, StatusBadge, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { createCommitment, settleCommitment, createRecurring } from "./actions";

export const metadata = { title: "Commitments — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function CommitmentsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const [commitments, recurring] = await Promise.all([
    safe<any>(() => db.from("commitments").select("id, description, counterparty, currency, amount, expected_settlement_date, status").eq("company_id", p.companyId).order("expected_settlement_date", { ascending: true, nullsFirst: false }).limit(200) as any),
    safe<any>(() => db.from("recurring_obligations").select("id, description, currency, amount, cadence, next_due").eq("company_id", p.companyId).order("next_due", { ascending: true, nullsFirst: false }).limit(200) as any),
  ]);

  const commitmentColumns: DataTableColumn<(typeof commitments)[number]>[] = [
    { key: "description", header: "Commitment", render: (c) => <span>{c.description} <span className="dim small">{c.counterparty ?? ""}</span></span> },
    { key: "amount", header: "Amount", align: "right", render: (c) => fmtMoney(c.amount, c.currency) },
    { key: "due", header: "Due", render: (c) => <span className="dim small">{fmtDate(c.expected_settlement_date) ?? "—"}</span> },
    { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
    {
      key: "action",
      header: "",
      render: (c) => c.status === "open" ? (
        <form action={settleCommitment}>
          <input type="hidden" name="id" value={c.id} />
          <Button variant="ghost" size="sm" type="submit">Settled</Button>
        </form>
      ) : null,
    },
  ];

  const recurringColumns: DataTableColumn<(typeof recurring)[number]>[] = [
    { key: "description", header: "Obligation", render: (r) => r.description },
    { key: "cadence", header: "Cadence", render: (r) => <Badge>{r.cadence}</Badge> },
    { key: "amount", header: "Amount", align: "right", render: (r) => fmtMoney(r.amount, r.currency) },
    { key: "next_due", header: "Next due", render: (r) => <span className="dim small">{fmtDate(r.next_due) ?? "—"}</span> },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Commitments &amp; Recurring</h1><p className="muted mt-1">Future outflows the cash forecast accounts for.</p></div>
        <Link className="btn ghost sm" href="/app/finance/forecast">Forecast →</Link>
      </div>

      <Card>
        <CardHeader title="One-off commitment" />
        <CardBody>
          <form action={createCommitment} className="row gap-1 wrap">
            <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="What's committed" required />
            <input name="counterparty" className="input" style={{ flex: "0 0 140px", minWidth: 120 }} placeholder="Counterparty" />
            <input name="amount" className="input" style={{ flex: "0 0 120px", minWidth: 100 }} placeholder="Amount" inputMode="decimal" />
            <label className="small dim">Due <input name="expected_settlement_date" type="date" className="input" style={{ width: 150 }} /></label>
            <Button variant="ghost" size="sm" type="submit">Add</Button>
          </form>
          <div className="mt-3">
            <DataTable columns={commitmentColumns} rows={commitments} keyExtractor={(c) => c.id} emptyTitle="No commitments" />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recurring obligation" />
        <CardBody>
          <form action={createRecurring} className="row gap-1 wrap">
            <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="e.g. Rent, Salaries" required />
            <select name="cadence" className="select" style={{ flex: "0 0 130px", minWidth: 110 }} defaultValue="monthly"><option value="weekly">weekly</option><option value="monthly">monthly</option><option value="quarterly">quarterly</option><option value="annual">annual</option></select>
            <input name="amount" className="input" style={{ flex: "0 0 120px", minWidth: 100 }} placeholder="Amount" inputMode="decimal" />
            <label className="small dim">Next due <input name="next_due" type="date" className="input" style={{ width: 150 }} /></label>
            <Button variant="ghost" size="sm" type="submit">Add</Button>
          </form>
          <div className="mt-3">
            <DataTable columns={recurringColumns} rows={recurring} keyExtractor={(r) => r.id} emptyTitle="No recurring obligations" />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
