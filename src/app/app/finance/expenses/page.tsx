/**
 * Finance → Expense Claims (§8.3). Review staff claims, approve/reject, and reimburse
 * approved ones (Dr Expense, Cr Cash via the atomic RPC). Recording only, not a bank
 * transfer. Company-scoped + audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { decideExpense, reimburseExpense } from "./actions";

export const metadata = { title: "Expense Claims — Singha" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function ExpensesPage() {
  const p = await requireDepartment("finance");
  const db = supabaseAdmin();

  const [claims, accounts] = await Promise.all([
    safe<any>(() => db.from("expense_claims").select("id, currency, amount, purpose, status, created_at, employees(name)").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200) as any),
    safe<any>(() => db.from("chart_of_accounts").select("code, name, type").eq("company_id", p.companyId).eq("is_active", true).order("code") as any),
  ]);
  const expenses = accounts.filter((a) => a.type === "expense");
  const assets = accounts.filter((a) => a.type === "asset");

  return (
    <div className="stack gap-3">
      <div><h1>Expense Claims</h1><p className="muted mt-1">Approve and reimburse staff expenses. Posting is not a bank transfer.</p></div>

      <div className="card">
        <div className="card-title">Claims ({claims.length})</div>
        {claims.length === 0 ? <div className="empty">No expense claims. Staff submit them from “My Work”.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Employee</th><th>Purpose</th><th className="num">Amount</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.employees?.name ?? "—"}</td>
                    <td>{c.purpose}</td>
                    <td className="num">{c.currency} {Number(c.amount).toLocaleString()}</td>
                    <td><span className={`badge ${c.status === "reimbursed" ? "ok" : c.status === "approved" ? "info" : c.status === "rejected" ? "danger" : "warn"}`}>{c.status}</span></td>
                    <td>
                      {c.status === "submitted" && (
                        <div className="row gap-1">
                          <form action={decideExpense}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value="approved" /><button className="btn ghost sm" type="submit">Approve</button></form>
                          <form action={decideExpense}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value="rejected" /><button className="btn ghost sm danger" type="submit">Reject</button></form>
                        </div>
                      )}
                      {c.status === "approved" && (expenses.length && assets.length ? (
                        <form action={reimburseExpense} className="row gap-1 wrap">
                          <input type="hidden" name="id" value={c.id} />
                          <select name="expense_code" className="select" style={{ width: 140, padding: "6px 8px" }}>{expenses.map((a: any) => <option key={a.code} value={a.code}>{a.code}</option>)}</select>
                          <select name="cash_code" className="select" style={{ width: 140, padding: "6px 8px" }}>{assets.map((a: any) => <option key={a.code} value={a.code}>{a.code}</option>)}</select>
                          <button className="btn sm" type="submit">Reimburse</button>
                        </form>
                      ) : <span className="small dim">add expense + cash accounts</span>)}
                    </td>
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
