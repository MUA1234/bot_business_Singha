/**
 * Finance → Chart of Accounts (§8.1). Company-scoped create + list of ledger
 * accounts. Audited; graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createAccount } from "./actions";

export const metadata = { title: "Chart of Accounts — Singha" };
const TYPES = ["asset", "liability", "equity", "income", "expense"];

export default async function ChartOfAccountsPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("chart_of_accounts")
      .select("code, name, type, is_active")
      .eq("company_id", p.companyId)
      .order("code")
      .limit(500);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Chart of Accounts</h1>
          <p className="muted mt-1">The ledger accounts you post journals to.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/journals">Journals →</Link>
      </div>

      <div className="card">
        <div className="card-title">New account</div>
        <form action={createAccount} className="row gap-1 wrap mt-2">
          <input name="code" className="input" style={{ width: 120 }} placeholder="Code (e.g. 1000)" required />
          <input name="name" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Account name" required />
          <select name="type" className="select" style={{ width: 150 }} defaultValue="asset">
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Accounts ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No accounts yet. Add a few (e.g. 1000 Cash / asset, 4000 Sales / income).</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Active</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.code}</td>
                    <td>{r.name}</td>
                    <td><span className="badge">{r.type}</span></td>
                    <td>{r.is_active ? <span className="badge ok">yes</span> : <span className="badge">no</span>}</td>
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
