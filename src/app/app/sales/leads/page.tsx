/**
 * Sales → Leads. Wires the pure lead scorer (src/modules/commercial/lead-scoring)
 * to real, company-scoped data: capture leads, advance stage, and rank by a
 * hot/warm/cold grade. Read/writes are company-scoped + audited; graceful before the
 * Phase-4 tables exist.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { scoreLead, type LeadStage } from "@/modules/commercial/lead-scoring";
import { createLead, setLeadStage } from "./actions";

export const metadata = { title: "Leads — Singha" };

const STAGES: LeadStage[] = ["new", "contacted", "qualified", "proposal", "won", "lost"];
const gradeBadge = (g: string) => (g === "hot" ? "danger" : g === "warm" ? "warn" : "");

export default async function LeadsPage() {
  const p = await requireDepartment("sales");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("leads")
      .select("id, name, contact, stage, estimated_value, currency, last_contact_at")
      .eq("company_id", p.companyId)
      .limit(300);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  const now = Date.now();
  const scored = rows
    .map((r) => {
      const days = r.last_contact_at ? Math.floor((now - new Date(r.last_contact_at).getTime()) / 86_400_000) : null;
      const s = scoreLead({ stage: r.stage, estimatedValue: Number(r.estimated_value ?? 0), lastContactDaysAgo: days });
      return { ...r, ...s };
    })
    .sort((a, b) => b.score - a.score);

  return (
    <div className="stack gap-3">
      <div>
        <h1>Leads</h1>
        <p className="muted mt-1">Pipeline ranked by urgency — hottest first.</p>
      </div>

      <div className="card">
        <div className="card-title">New lead</div>
        <form action={createLead} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Lead name" required />
          <input name="contact" className="input" style={{ flex: 1, minWidth: 120 }} placeholder="Contact" />
          <input name="source" className="input" style={{ width: 120 }} placeholder="Source" />
          <input name="estimated_value" className="input" style={{ width: 130 }} placeholder="Value" inputMode="numeric" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Pipeline ({scored.length})</div>
        {scored.length === 0 ? (
          <div className="empty">No leads yet. Add one above.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Lead</th><th>Value</th><th>Grade</th><th>Stage</th><th>Move to</th></tr>
              </thead>
              <tbody>
                {scored.map((r) => (
                  <tr key={r.id}>
                    <td><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small dim">{r.contact ?? ""}</div></td>
                    <td className="dim small">{r.currency ?? "LKR"} {Number(r.estimated_value ?? 0).toLocaleString()}</td>
                    <td><span className={`badge ${gradeBadge(r.grade)}`}>{r.grade} · {r.score}</span></td>
                    <td><span className="badge">{r.stage}</span></td>
                    <td>
                      <div className="row gap-1 wrap">
                        {STAGES.filter((s) => s !== r.stage).map((s) => (
                          <form action={setLeadStage} key={s}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="stage" value={s} />
                            <button className="btn ghost sm" type="submit">{s}</button>
                          </form>
                        ))}
                      </div>
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
