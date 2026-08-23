/**
 * RSK-005 — Incident log. Company-scoped list and create form.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { createIncident, updateIncidentStatus } from "./actions";
import { severityBadgeClass, sortIncidentsBySeverity } from "@/modules/legal/incidents";

export const metadata = { title: "Incidents — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function IncidentsPage() {
  const p = await requireDepartment("legal");
  const db = supabaseReadClient();

  const rows = await safe<any>(() =>
    db
      .from("incidents")
      .select("id, title, description, occurred_at, severity, status, root_cause, corrective_action, evidence")
      .eq("company_id", p.companyId)
      .order("occurred_at", { ascending: false })
      .limit(300) as any,
  );

  const sorted = sortIncidentsBySeverity(rows);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Incident log</h1>
          <p className="muted mt-1">Record and track incidents, root causes and corrective actions.</p>
        </div>
        <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
      </div>

      <div className="card">
        <div className="card-title">New incident</div>
        <form action={createIncident} className="stack gap-2 mt-2">
          <div className="row gap-1 wrap">
            <input name="title" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Incident title" required />
            <select name="severity" className="input" style={{ width: 120 }} defaultValue="medium">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select name="status" className="input" style={{ width: 140 }} defaultValue="open">
              <option value="open">Open</option>
              <option value="investigating">Investigating</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
            <label className="small dim">Occurred <input name="occurred_at" type="datetime-local" className="input" style={{ width: 180 }} /></label>
          </div>
          <textarea name="description" className="textarea" placeholder="Description" />
          <textarea name="root_cause" className="textarea" placeholder="Root cause" />
          <textarea name="corrective_action" className="textarea" placeholder="Corrective action" />
          <textarea name="evidence" className="textarea" placeholder="Evidence / source" />
          <button className="btn" type="submit">Add incident</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All incidents ({sorted.length})</div>
        {sorted.length === 0 ? (
          <div className="empty">No incidents recorded yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Incident</th><th>Severity</th><th>Status</th><th>Occurred</th><th></th></tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.title}</div>
                      {r.description ? <div className="dim small">{r.description}</div> : null}
                      {r.root_cause ? <div className="small">Root cause: {r.root_cause}</div> : null}
                      {r.corrective_action ? <div className="small">Action: {r.corrective_action}</div> : null}
                      {r.evidence ? <div className="small dim">Evidence: {r.evidence}</div> : null}
                    </td>
                    <td><span className={`badge ${severityBadgeClass(r.severity)}`}>{r.severity}</span></td>
                    <td><span className="badge">{r.status}</span></td>
                    <td className="dim small">{r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "—"}</td>
                    <td>
                      <form action={updateIncidentStatus} className="row gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <select name="status" className="input sm" defaultValue={r.status}>
                          <option value="open">open</option>
                          <option value="investigating">investigating</option>
                          <option value="resolved">resolved</option>
                          <option value="closed">closed</option>
                        </select>
                        <button className="btn sm" type="submit">Update</button>
                      </form>
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
