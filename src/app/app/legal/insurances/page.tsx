/**
 * Legal → Insurance register (RSK-004). Company-scoped create + list with cover,
 * expiry and renewal flags. Audited, graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { createInsurance } from "./actions";

export const metadata = { title: "Insurances — Singha Central" };

export default async function InsurancesPage() {
  const p = await requireDepartment("legal");
  const now = new Date();

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient()
      .from("insurances")
      .select("id, policy_name, insurer, policy_number, cover_amount, currency, expiry_date, status")
      .eq("company_id", p.companyId)
      .order("expiry_date", { ascending: true, nullsFirst: false })
      .limit(300)).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Insurance register</h1>
          <p className="muted mt-1">Policies, cover and expiry dates.</p>
        </div>
        <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
      </div>

      <div className="card">
        <div className="card-title">New insurance</div>
        <form action={createInsurance} className="row gap-1 wrap mt-2">
          <input name="policy_name" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Policy name" required />
          <input name="insurer" className="input" style={{ flex: 1, minWidth: 130 }} placeholder="Insurer" />
          <input name="policy_number" className="input" style={{ width: 130 }} placeholder="Policy number" />
          <input name="cover_amount" className="input" style={{ width: 110 }} placeholder="Cover" type="number" step="0.01" />
          <input name="currency" className="input" style={{ width: 70 }} placeholder="LKR" defaultValue="LKR" />
          <label className="small dim">Expiry <input name="expiry_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All insurances ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No insurance policies yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Policy</th><th>Insurer</th><th>Number</th><th>Cover</th><th>Expiry</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const st = renewalStatus(r.expiry_date ?? null, now, 45);
                  const badge = st === "expired" ? "danger" : st === "due_soon" ? "warn" : "";
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.policy_name}</td>
                      <td className="dim small">{r.insurer ?? "—"}</td>
                      <td className="mono dim small">{r.policy_number ?? "—"}</td>
                      <td className="num">{r.cover_amount != null ? fmtMoney(String(r.cover_amount), r.currency) : "—"}</td>
                      <td>{r.expiry_date ? <span className={`badge ${badge}`}>{r.expiry_date}</span> : <span className="dim small">—</span>}</td>
                      <td><span className="badge">{r.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
