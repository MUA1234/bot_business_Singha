/**
 * Legal → Risk register (RSK-001). Company-scoped create + list with owner,
 * mitigation, evidence and review dates. Audited, graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { EmptyState } from "@/components/ui/EmptyState";

import { supabaseReadClient } from "@/lib/supabase/read";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { createRisk } from "./actions";

export const metadata = { title: "Risks — Singha Central" };

export default async function RisksPage() {
  const p = await requireDepartment("legal");
  const now = new Date();

  let rows: any[] = [];
  let profiles: any[] = [];
  try {
    const db = supabaseReadClient();
    const [{ data: risks }, { data: people }] = await Promise.all([
      db.from("risks").select("id, title, description, owner_id, mitigation, evidence, review_date, status").eq("company_id", p.companyId).order("review_date", { ascending: true, nullsFirst: false }).limit(300),
      db.from("profiles").select("id, full_name").eq("company_id", p.companyId).limit(200),
    ]);
    rows = risks ?? [];
    profiles = people ?? [];
  } catch {
    rows = [];
    profiles = [];
  }

  const byProfile = new Map(profiles.map((x) => [x.id, x.full_name ?? "—"]));

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Risk register</h1>
          <p className="muted mt-1">Risks with owner, mitigation, evidence and review dates.</p>
        </div>
        <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
      </div>

      <div className="card">
        <div className="card-title">New risk</div>
        <form action={createRisk} className="stack gap-2 mt-2">
          <div className="row gap-1 wrap">
            <input name="title" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Risk title" required />
            <select name="owner_id" className="select" style={{ width: 180 }}>
              <option value="">No owner</option>
              {profiles.map((x) => <option key={x.id} value={x.id}>{x.full_name ?? x.id}</option>)}
            </select>
            <label className="small dim">Review <input name="review_date" type="date" className="input" style={{ width: 150 }} /></label>
          </div>
          <textarea name="description" className="textarea" placeholder="Description" />
          <textarea name="mitigation" className="textarea" placeholder="Mitigation" />
          <textarea name="evidence" className="textarea" placeholder="Evidence / source" />
          <button className="btn" type="submit">Add risk</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All risks ({rows.length})</div>
        {rows.length === 0 ? (
          <EmptyState title="No risks recorded yet." icon="shield" />
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Risk</th><th>Owner</th><th>Status</th><th>Review</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const st = renewalStatus(r.review_date ?? null, now, 45);
                  const badge = st === "expired" ? "danger" : st === "due_soon" ? "warn" : "";
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.title}</div>
                        {r.description ? <div className="dim small">{r.description}</div> : null}
                      </td>
                      <td className="dim small">{byProfile.get(r.owner_id) ?? "—"}</td>
                      <td><span className="badge">{r.status}</span></td>
                      <td>{r.review_date ? <span className={`badge ${badge}`}>{r.review_date}</span> : <span className="dim small">—</span>}</td>
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
