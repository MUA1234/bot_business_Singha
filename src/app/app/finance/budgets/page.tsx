/**
 * FIN-006 — Budgets vs actual. Company-scoped list of budgets with a create form.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createBudget } from "./actions";

export const metadata = { title: "Budgets vs Actual — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function BudgetsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [budgets, fiscalYears] = await Promise.all([
    safe<any>(() =>
      db
        .from("budgets")
        .select("id, name, fiscal_year_id, currency, budget_lines(id)")
        .eq("company_id", p.companyId)
        .order("name") as any,
    ),
    safe<any>(() => db.from("fiscal_years").select("id, name").eq("company_id", p.companyId).order("name") as any),
  ]);

  const fyById = new Map(fiscalYears.map((fy) => [fy.id, fy.name]));

  return (
    <div className="stack gap-3">
      <div>
        <h1>Budgets vs actual</h1>
        <p className="muted mt-1">Build budgets by period and compare them to actual journal activity.</p>
      </div>

      <div className="card">
        <div className="card-title">New budget</div>
        <form action={createBudget} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Budget name" required />
          <select name="fiscal_year_id" className="input" style={{ width: 160 }}>
            <option value="">Fiscal year…</option>
            {fiscalYears.map((fy) => (
              <option key={fy.id} value={fy.id}>{fy.name}</option>
            ))}
          </select>
          <input name="currency" className="input" style={{ width: 80 }} placeholder="LKR" defaultValue="LKR" maxLength={3} />
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Budgets ({budgets.length})</div>
        {budgets.length === 0 ? (
          <div className="empty">No budgets yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Fiscal year</th><th className="num">Lines</th><th className="num">Currency</th><th></th></tr>
              </thead>
              <tbody>
                {budgets.map((b) => (
                  <tr key={b.id}>
                    <td><Link href={`/app/finance/budgets/${b.id}`} className="link">{b.name}</Link></td>
                    <td className="dim">{b.fiscal_year_id ? fyById.get(b.fiscal_year_id) ?? "—" : "—"}</td>
                    <td className="num">{Array.isArray(b.budget_lines) ? b.budget_lines.length : 0}</td>
                    <td className="num mono">{b.currency}</td>
                    <td><Link href={`/app/finance/budgets/${b.id}`} className="btn ghost sm">View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
