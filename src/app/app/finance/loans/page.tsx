/**
 * Finance → Loans (§8.3). Loan register with a generated amortization schedule.
 * Company-scoped + audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, Button, StatusBadge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate, fmtNumber } from "@/lib/format";
import { createLoan } from "./actions";

export const metadata = { title: "Loans — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function LoansPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const [loans, schedules] = await Promise.all([
    safe<any>(() => db.from("loans").select("id, counterparty, principal, currency, interest_rate, start_date, status").eq("company_id", p.companyId).order("start_date", { ascending: false }).limit(100) as any),
    safe<any>(() => db.from("loan_schedules").select("loan_id, due_date, principal_due, interest_due, status").eq("company_id", p.companyId).order("due_date") as any),
  ]);
  const byLoan = new Map<string, any[]>();
  for (const s of schedules) { const l = byLoan.get(s.loan_id) ?? []; l.push(s); byLoan.set(s.loan_id, l); }

  return (
    <div className="stack gap-3">
      <div><h1>Loans</h1><p className="muted mt-1">Register a loan and see its amortization schedule.</p></div>

      <Card>
        <CardHeader title="New loan" />
        <CardBody>
          <form action={createLoan} className="row gap-1 wrap">
            <input name="counterparty" className="input" style={{ flex: "0 0 160px", minWidth: 140 }} placeholder="Lender / borrower" />
            <input name="principal" className="input" style={{ flex: "0 0 130px", minWidth: 110 }} placeholder="Principal" inputMode="decimal" />
            <input name="interest_rate" className="input" style={{ flex: "0 0 100px", minWidth: 80 }} placeholder="Rate % p.a." inputMode="decimal" />
            <input name="term_months" className="input" style={{ flex: "0 0 100px", minWidth: 80 }} placeholder="Months" inputMode="numeric" />
            <label className="small dim">Start <input name="start_date" type="date" className="input" style={{ width: 150 }} /></label>
            <Button type="submit">Create + schedule</Button>
          </form>
        </CardBody>
      </Card>

      {loans.length === 0 ? (
        <Card>
          <EmptyState title="No loans yet" />
        </Card>
      ) : loans.map((l) => {
        const sched = byLoan.get(l.id) ?? [];
        const columns: DataTableColumn<(typeof sched)[number]>[] = [
          { key: "due", header: "Due", render: (s) => <span className="dim small">{fmtDate(s.due_date)}</span> },
          { key: "principal", header: "Principal", align: "right", render: (s) => fmtMoney(s.principal_due) },
          { key: "interest", header: "Interest", align: "right", render: (s) => fmtMoney(s.interest_due) },
          { key: "status", header: "Status", render: (s) => <StatusBadge status={s.status} /> },
        ];
        return (
          <Card key={l.id}>
            <CardHeader
              title={
                <span>{l.counterparty ?? "Loan"} — {fmtMoney(l.principal, l.currency)} @ {fmtNumber(Number(l.interest_rate))}% <StatusBadge status={l.status} /></span>
              }
            />
            <CardBody>
              <DataTable columns={columns} rows={sched.slice(0, 24)} keyExtractor={(s) => `${l.id}-${s.due_date}-${s.principal_due}-${s.interest_due}`} emptyTitle="No schedule" />
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
