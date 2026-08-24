/**
 * Reusable Risks panel. Used by `/app/legal/risks` and the spatial workspace.
 * The caller must enforce permission (legal department or admin).
 */
import Link from "next/link";
import { createRisk } from "@/app/app/legal/risks/actions";
import { EmptyState } from "@/components/ui/EmptyState";

export type PlainObject = Record<string, unknown>;

export interface ProfileOption {
  id: string;
  full_name: string | null;
}

export interface RiskRow {
  id: string;
  title: string;
  description: string | null;
  ownerName: string;
  mitigation: string | null;
  evidence: string | null;
  reviewDate: string | null;
  status: string;
  reviewBadgeClass: string;
}

export interface RisksPanelData {
  risks: RiskRow[];
  profiles: ProfileOption[];
}

export function RisksPanelContent({
  data,
  embedded,
}: {
  data: PlainObject;
  embedded?: boolean;
}) {
  const { risks, profiles } = data as unknown as RisksPanelData;

  return (
    <div className="stack gap-3">
      {!embedded && (
        <div className="row between">
          <div>
            <h1>Risk register</h1>
            <p className="muted mt-1">Risks with owner, mitigation, evidence and review dates.</p>
          </div>
          <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
        </div>
      )}

      <div className="card">
        <div className="card-title">New risk</div>
        <form action={createRisk} className="stack gap-2 mt-2">
          <div className="row gap-1 wrap">
            <input name="title" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Risk title" required />
            <select name="owner_id" className="select" style={{ width: 180 }}>
              <option value="">No owner</option>
              {profiles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.full_name ?? x.id}
                </option>
              ))}
            </select>
            <label className="small dim">
              Review <input name="review_date" type="date" className="input" style={{ width: 150 }} />
            </label>
          </div>
          <textarea name="description" className="textarea" placeholder="Description" />
          <textarea name="mitigation" className="textarea" placeholder="Mitigation" />
          <textarea name="evidence" className="textarea" placeholder="Evidence / source" />
          <button className="btn" type="submit">Add risk</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All risks ({risks.length})</div>
        {risks.length === 0 ? (
          <EmptyState title="No risks recorded yet." icon="shield" />
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Risk</th><th>Owner</th><th>Status</th><th>Review</th></tr>
              </thead>
              <tbody>
                {risks.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.title}</div>
                      {r.description ? <div className="dim small">{r.description}</div> : null}
                    </td>
                    <td className="dim small">{r.ownerName}</td>
                    <td><span className="badge">{r.status}</span></td>
                    <td>
                      {r.reviewDate ? (
                        <span className={`badge ${r.reviewBadgeClass}`}>{r.reviewDate}</span>
                      ) : (
                        <span className="dim small">—</span>
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
