/**
 * Finance → Periods (§8.1/§8.3). Fiscal years and their monthly periods. Closing (or
 * locking) a period blocks new journals dated inside it — enforced by the posting RPC.
 * Reopening is a controlled, audited action. Company-scoped, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createFiscalYear, setPeriodStatus } from "./actions";

export const metadata = { title: "Periods — Singha" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function PeriodsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const thisYear = new Date().getUTCFullYear();

  const [years, periods] = await Promise.all([
    safe<any>(() => db.from("fiscal_years").select("id, name, status").eq("company_id", p.companyId).order("name", { ascending: false }) as any),
    safe<any>(() => db.from("accounting_periods").select("id, fiscal_year_id, name, status").eq("company_id", p.companyId).order("name") as any),
  ]);
  const byYear = new Map<string, any[]>();
  for (const pr of periods) {
    const list = byYear.get(pr.fiscal_year_id) ?? [];
    list.push(pr);
    byYear.set(pr.fiscal_year_id, list);
  }
  const badge = (s: string) => (s === "open" ? "ok" : s === "locked" ? "danger" : "warn");

  return (
    <div className="stack gap-3">
      <div><h1>Accounting Periods</h1><p className="muted mt-1">Close a period to lock the ledger against it. Reopening is audited.</p></div>

      <div className="card">
        <div className="card-title">New fiscal year</div>
        <form action={createFiscalYear} className="row gap-1 mt-2">
          <input name="year" className="input" style={{ width: 120 }} placeholder="Year" inputMode="numeric" defaultValue={String(thisYear)} />
          <button className="btn" type="submit">Create year + 12 periods</button>
        </form>
      </div>

      {years.length === 0 ? (
        <div className="card"><div className="empty">No fiscal years yet.</div></div>
      ) : years.map((y) => (
        <div key={y.id} className="card">
          <div className="card-title">FY {y.name} <span className={`badge ${badge(y.status)}`}>{y.status}</span></div>
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Period</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {(byYear.get(y.id) ?? []).map((pr) => (
                  <tr key={pr.id}>
                    <td className="mono">{pr.name}</td>
                    <td><span className={`badge ${badge(pr.status)}`}>{pr.status}</span></td>
                    <td>
                      <div className="row gap-1 wrap">
                        {pr.status === "open" && (
                          <form action={setPeriodStatus}><input type="hidden" name="id" value={pr.id} /><input type="hidden" name="status" value="closed" /><button className="btn ghost sm" type="submit">Close</button></form>
                        )}
                        {pr.status === "closed" && (
                          <>
                            <form action={setPeriodStatus}><input type="hidden" name="id" value={pr.id} /><input type="hidden" name="status" value="open" /><button className="btn ghost sm" type="submit">Reopen</button></form>
                            <form action={setPeriodStatus}><input type="hidden" name="id" value={pr.id} /><input type="hidden" name="status" value="locked" /><button className="btn ghost sm danger" type="submit">Lock</button></form>
                          </>
                        )}
                        {pr.status === "locked" && (
                          <form action={setPeriodStatus}><input type="hidden" name="id" value={pr.id} /><input type="hidden" name="status" value="open" /><button className="btn ghost sm" type="submit">Reopen</button></form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
