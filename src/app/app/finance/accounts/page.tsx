/**
 * Finance → Bank & Cash Accounts (§8.3). These feed the cash position and forecast.
 * Company-scoped create + list, audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { createBankAccount, createCashAccount } from "./actions";

export const metadata = { title: "Bank & Cash — Singha" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

function AccountCard({ title, rows, action, kind }: { title: string; rows: any[]; action: (fd: FormData) => void; kind: string }) {
  return (
    <div className="card">
      <div className="card-title">{title} ({rows.length})</div>
      <form action={action} className="row gap-1 wrap mt-2">
        <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder={`${kind} name`} required />
        <input name="currency" className="input" style={{ width: 80 }} placeholder="LKR" defaultValue="LKR" />
        <input name="opening_balance" className="input" style={{ width: 130 }} placeholder="Opening bal." inputMode="decimal" />
        <input name="gl_account_code" className="input" style={{ width: 110 }} placeholder="GL code" />
        <button className="btn ghost sm" type="submit">Add</button>
      </form>
      {rows.length > 0 && (
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Name</th><th>Ccy</th><th className="num">Opening</th><th>GL</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td className="dim small">{r.currency}</td>
                  <td className="num">{fmtMoney(r.opening_balance)}</td>
                  <td className="mono dim small">{r.gl_account_code ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default async function AccountsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const [banks, cashes] = await Promise.all([
    safe<any>(() => db.from("bank_accounts").select("id, name, currency, opening_balance, gl_account_code").eq("company_id", p.companyId).order("name") as any),
    safe<any>(() => db.from("cash_accounts").select("id, name, currency, opening_balance, gl_account_code").eq("company_id", p.companyId).order("name") as any),
  ]);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Bank &amp; Cash</h1>
          <p className="muted mt-1">Accounts behind your cash position and forecast.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/forecast">Forecast →</Link>
      </div>
      <AccountCard title="Bank accounts" rows={banks} action={createBankAccount} kind="Bank account" />
      <AccountCard title="Cash accounts" rows={cashes} action={createCashAccount} kind="Cash account" />
    </div>
  );
}
