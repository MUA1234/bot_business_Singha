/**
 * Procurement → Purchase Requests. Company-scoped create + status flow (audited).
 * Graceful before the Phase-4 tables exist.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createPurchaseRequest, setPurchaseRequestStatus } from "./actions";

export const metadata = { title: "Purchase Requests — Singha" };

const NEXT: Record<string, string[]> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected"],
  approved: ["ordered"],
  ordered: ["closed"],
  rejected: [],
  closed: [],
};

export default async function PurchaseRequestsPage() {
  const p = await requireDepartment("procurement");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("purchase_requests")
      .select("id, title, estimated_cost, currency, status, created_at")
      .eq("company_id", p.companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Purchase Requests</h1>
        <p className="muted mt-1">Raise a request, then move it through approval to order.</p>
      </div>

      <div className="card">
        <div className="card-title">New request</div>
        <form action={createPurchaseRequest} className="stack gap-2 mt-2" style={{ maxWidth: 560 }}>
          <input name="title" className="input" placeholder="What do you need?" required />
          <textarea name="description" className="textarea" placeholder="Details (optional)" />
          <input name="estimated_cost" className="input" style={{ width: 180 }} placeholder="Estimated cost" inputMode="numeric" />
          <button className="btn" type="submit">Create request</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All requests ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No purchase requests yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Request</th><th>Est. cost</th><th>Status</th><th>Move to</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td className="dim small">{r.estimated_cost != null ? `${r.currency ?? "LKR"} ${Number(r.estimated_cost).toLocaleString()}` : "—"}</td>
                    <td><span className="badge">{r.status}</span></td>
                    <td>
                      <div className="row gap-1 wrap">
                        {(NEXT[r.status] ?? []).length === 0 ? <span className="small dim">—</span> :
                          (NEXT[r.status] ?? []).map((s) => (
                            <form action={setPurchaseRequestStatus} key={s}>
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
