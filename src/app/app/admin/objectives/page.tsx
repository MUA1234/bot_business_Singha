/**
 * Admin → Objectives / KPIs (§10.1). Company-scoped goals with progress vs time,
 * graded by the pure objective-status engine. Create + update progress. Audited,
 * graceful.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { assessObjective, type ObjectiveStatus } from "@/management/ai-manager/objective-status";
import { createObjective, updateObjectiveProgress } from "./actions";

export const metadata = { title: "Objectives — Singha Central" };

const badge: Record<ObjectiveStatus, string> = { done: "ok", on_track: "ok", at_risk: "warn", off_track: "danger" };

export default async function ObjectivesPage() {
  const admin = await requireAdmin();

  let rows: any[] = [];
  try {
    rows = (await supabaseAdmin().from("objectives")
      .select("id, title, metric, unit, target_value, current_value, period_start, period_end")
      .eq("company_id", admin.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Objectives &amp; KPIs</h1>
          <p className="muted mt-1">Goals graded by progress against the clock.</p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
      </div>

      <div className="card">
        <div className="card-title">New objective</div>
        <form action={createObjective} className="row gap-1 wrap mt-2">
          <input name="title" className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Objective" required />
          <input name="metric" className="input" style={{ width: 130 }} placeholder="Metric" />
          <input name="target_value" className="input" style={{ width: 110 }} placeholder="Target" inputMode="decimal" />
          <input name="unit" className="input" style={{ width: 80 }} placeholder="Unit" />
          <label className="small dim">From <input name="period_start" type="date" className="input" style={{ width: 145 }} /></label>
          <label className="small dim">To <input name="period_end" type="date" className="input" style={{ width: 145 }} /></label>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Objectives ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No objectives yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Objective</th><th className="num">Progress</th><th>Status</th><th>Update</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const a = assessObjective({ target: Number(r.target_value ?? 0), current: Number(r.current_value ?? 0), periodStart: r.period_start, periodEnd: r.period_end });
                  return (
                    <tr key={r.id}>
                      <td><div style={{ fontWeight: 600 }}>{r.title}</div><div className="small dim">{r.metric ?? ""}</div></td>
                      <td className="num">{Number(r.current_value ?? 0)} / {Number(r.target_value ?? 0)} {r.unit ?? ""} <span className="dim">({Math.round(a.progressPct * 100)}%)</span></td>
                      <td><span className={`badge ${badge[a.status]}`}>{a.status.replace(/_/g, " ")}</span></td>
                      <td>
                        <form action={updateObjectiveProgress} className="row gap-1">
                          <input type="hidden" name="id" value={r.id} />
                          <input name="current_value" className="input" style={{ width: 90, padding: "6px 8px" }} placeholder="current" inputMode="decimal" />
                          <button className="btn ghost sm" type="submit">Save</button>
                        </form>
                      </td>
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
