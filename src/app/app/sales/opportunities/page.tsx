/**
 * Sales → Opportunities (§9.1). Deals with amount + probability; a probability-
 * weighted forecast via the pure pipeline engine. Company-scoped + audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { summarizePipeline, type Opportunity } from "@/modules/commercial/pipeline-value";
import { createOpportunity, setOpportunityStatus } from "./actions";

export const metadata = { title: "Opportunities — Singha" };

export default async function OpportunitiesPage() {
  const p = await requireDepartment("sales");
  const db = supabaseReadClient();

  let rows: any[] = [];
  let leads: any[] = [];
  try {
    rows = (await db.from("opportunities").select("id, title, amount, currency, probability, expected_close, status").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
    leads = (await db.from("leads").select("id, name").eq("company_id", p.companyId).not("stage", "in", "(won,lost)").order("name")).data ?? [];
  } catch {
    rows = [];
  }

  const currency = rows[0]?.currency ?? "LKR";
  const summary = summarizePipeline(rows.map((r): Opportunity => ({ amount: Number(r.amount ?? 0), probability: Number(r.probability ?? 0), status: r.status })));
  const m = (n: number) => `${currency} ${n.toLocaleString()}`;

  return (
    <div className="stack gap-3">
      <div><h1>Opportunities</h1><p className="muted mt-1">Open deals and the probability-weighted forecast.</p></div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Open pipeline</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(summary.openValue)}</div><div className="d dim">{summary.openCount} deals</div></div>
        <div className="card stat"><div className="k">Weighted forecast</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--info)" }}>{m(summary.weightedValue)}</div></div>
        <div className="card stat"><div className="k">Won</div><div className="v" style={{ fontSize: "1.4rem", color: "var(--ok)" }}>{m(summary.wonValue)}</div></div>
      </div>

      <div className="card">
        <div className="card-title">New opportunity</div>
        <form action={createOpportunity} className="row gap-1 wrap mt-2">
          <input name="title" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Deal name" required />
          <input name="amount" className="input" style={{ width: 130 }} placeholder="Amount" inputMode="decimal" />
          <input name="probability" className="input" style={{ width: 90 }} placeholder="Prob %" inputMode="numeric" />
          <label className="small dim">Close <input name="expected_close" type="date" className="input" style={{ width: 150 }} /></label>
          <select name="lead_id" className="select" style={{ width: 150 }} defaultValue="">
            <option value="">No lead</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Deals ({rows.length})</div>
        {rows.length === 0 ? <div className="empty">No opportunities yet.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Deal</th><th className="num">Amount</th><th className="num">Prob</th><th>Close</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td className="num">{m(Number(r.amount ?? 0))}</td>
                    <td className="num">{Number(r.probability ?? 0)}%</td>
                    <td className="dim small">{r.expected_close ?? "—"}</td>
                    <td><span className={`badge ${r.status === "won" ? "ok" : r.status === "lost" ? "danger" : "warn"}`}>{r.status}</span></td>
                    <td>
                      {r.status === "open" && (
                        <div className="row gap-1">
                          <form action={setOpportunityStatus}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value="won" /><button className="btn ghost sm" type="submit">Won</button></form>
                          <form action={setOpportunityStatus}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value="lost" /><button className="btn ghost sm danger" type="submit">Lost</button></form>
                        </div>
                      )}
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
