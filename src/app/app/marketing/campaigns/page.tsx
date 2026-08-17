/**
 * Marketing → Campaigns (§9). Company-scoped create + a lifecycle (draft → scheduled
 * → running → done). Actual sending stays gated (approved WhatsApp templates + the
 * outbox worker). Audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createCampaign, setCampaignStatus } from "./actions";

export const metadata = { title: "Campaigns — Singha Central" };

const NEXT: Record<string, string[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["running", "cancelled"],
  running: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

export default async function CampaignsPage() {
  const p = await requireDepartment("marketing");
  const db = supabaseReadClient();

  let rows: any[] = [];
  let audiences: any[] = [];
  try {
    rows = (await db.from("campaigns").select("id, name, channel, status, budget, currency, sent_count, audiences(name)").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
    audiences = (await db.from("audiences").select("id, name").eq("company_id", p.companyId).order("name")).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Campaigns</h1>
        <p className="muted mt-1">Plan campaigns and move them through their lifecycle. Sending uses approved templates.</p>
      </div>

      <div className="card">
        <div className="card-title">New campaign</div>
        <form action={createCampaign} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Campaign name" required />
          <select name="channel" className="select" style={{ width: 130 }} defaultValue="whatsapp">
            <option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="other">Other</option>
          </select>
          <select name="audience_id" className="select" style={{ width: 160 }} defaultValue="">
            <option value="">No audience</option>
            {audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input name="budget" className="input" style={{ width: 120 }} placeholder="Budget" inputMode="decimal" />
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Campaigns ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No campaigns yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Name</th><th>Channel</th><th>Audience</th><th>Status</th><th>Move to</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td><span className="badge">{r.channel}</span></td>
                    <td className="dim small">{r.audiences?.name ?? "—"}</td>
                    <td><span className="badge">{r.status}</span></td>
                    <td>
                      <div className="row gap-1 wrap">
                        {(NEXT[r.status] ?? []).length === 0 ? <span className="small dim">—</span> :
                          (NEXT[r.status] ?? []).map((s) => (
                            <form action={setCampaignStatus} key={s}>
                              <input type="hidden" name="id" value={r.id} />
                              <input type="hidden" name="status" value={s} />
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
