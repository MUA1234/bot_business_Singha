/**
 * Finance → Loans (§8.3). Loan register with a generated amortization schedule.
 * Company-scoped + audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
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

      <div className="card">
        <div className="card-title">New loan</div>
        <form action={createLoan} className="row gap-1 wrap mt-2">
          <input name="counterparty" className="input" style={{ width: 160 }} placeholder="Lender / borrower" />
          <input name="principal" className="input" style={{ width: 130 }} placeholder="Principal" inputMode="decimal" />
          <input name="interest_rate" className="input" style={{ width: 100 }} placeholder="Rate % p.a." inputMode="decimal" />
          <input name="term_months" className="input" style={{ width: 100 }} placeholder="Months" inputMode="numeric" />
          <label className="small dim">Start <input name="start_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn" type="submit">Create + schedule</button>
        </form>
      </div>

      {loans.length === 0 ? (
        <div className="card"><div className="empty">No loans yet.</div></div>
      ) : loans.map((l) => {
        const sched = byLoan.get(l.id) ?? [];
        return (
          <div key={l.id} className="card">
            <div className="card-title">{l.counterparty ?? "Loan"} — {fmtMoney(l.principal, l.currency)} @ {Number(l.interest_rate)}% <span className="badge">{l.status}</span></div>
            <div className="table-wrap mt-3">
              <table className="data">
                <thead><tr><th>Due</th><th className="num">Principal</th><th className="num">Interest</th><th>Status</th></tr></thead>
                <tbody>
                  {sched.slice(0, 24).map((s, i) => (
                    <tr key={i}><td className="dim small">{s.due_date}</td><td className="num">{fmtMoney(s.principal_due)}</td><td className="num">{fmtMoney(s.interest_due)}</td><td><span className="badge">{s.status}</span></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
