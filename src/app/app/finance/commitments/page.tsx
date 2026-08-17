/**
 * Finance → Commitments & Recurring (§8.5). Future outflows that the cash forecast
 * should account for beyond invoices/bills (rent, salaries, contracted spend).
 * Company-scoped + audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { createCommitment, settleCommitment, createRecurring } from "./actions";

export const metadata = { title: "Commitments — Singha" };

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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Commitments &amp; Recurring</h1><p className="muted mt-1">Future outflows the cash forecast accounts for.</p></div>
        <Link className="btn ghost sm" href="/app/finance/forecast">Forecast →</Link>
      </div>

      <div className="card">
        <div className="card-title">One-off commitment</div>
        <form action={createCommitment} className="row gap-1 wrap mt-2">
          <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="What's committed" required />
          <input name="counterparty" className="input" style={{ width: 140 }} placeholder="Counterparty" />
          <input name="amount" className="input" style={{ width: 120 }} placeholder="Amount" inputMode="decimal" />
          <label className="small dim">Due <input name="expected_settlement_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn ghost sm" type="submit">Add</button>
        </form>
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Commitment</th><th className="num">Amount</th><th>Due</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {commitments.length === 0 && <tr><td colSpan={5}><div className="empty">No commitments.</div></td></tr>}
              {commitments.map((c) => (
                <tr key={c.id}>
                  <td>{c.description} <span className="dim small">{c.counterparty ?? ""}</span></td>
                  <td className="num">{fmtMoney(c.amount, c.currency)}</td>
                  <td className="dim small">{c.expected_settlement_date ?? "—"}</td>
                  <td><span className={`badge ${c.status === "settled" ? "ok" : "warn"}`}>{c.status}</span></td>
                  <td>{c.status === "open" && <form action={settleCommitment}><input type="hidden" name="id" value={c.id} /><button className="btn ghost sm" type="submit">Settled</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Recurring obligation</div>
        <form action={createRecurring} className="row gap-1 wrap mt-2">
          <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="e.g. Rent, Salaries" required />
          <select name="cadence" className="select" style={{ width: 130 }} defaultValue="monthly"><option value="weekly">weekly</option><option value="monthly">monthly</option><option value="quarterly">quarterly</option><option value="annual">annual</option></select>
          <input name="amount" className="input" style={{ width: 120 }} placeholder="Amount" inputMode="decimal" />
          <label className="small dim">Next due <input name="next_due" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn ghost sm" type="submit">Add</button>
        </form>
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Obligation</th><th>Cadence</th><th className="num">Amount</th><th>Next due</th></tr></thead>
            <tbody>
              {recurring.length === 0 && <tr><td colSpan={4}><div className="empty">No recurring obligations.</div></td></tr>}
              {recurring.map((r) => (
                <tr key={r.id}><td>{r.description}</td><td><span className="badge">{r.cadence}</span></td><td className="num">{fmtMoney(r.amount, r.currency)}</td><td className="dim small">{r.next_due ?? "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
