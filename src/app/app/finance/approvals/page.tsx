import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Approvals — Singha" };

export default async function ApprovalsPage() {
  const p = await requireDepartment("finance");
  const { data: log } = await supabaseAdmin()
    .from("price_confirmations")
    .select("id, description, currency, resolved_price, status, resolved_at, department")
    .eq("company_id", p.companyId)
    .in("status", ["resolved", "dismissed"])
    .order("resolved_at", { ascending: false })
    .limit(200);

  return (
    <div className="stack gap-3">
      <div>
        <h1>Approvals &amp; decisions</h1>
        <p className="muted mt-1">Audit trail of price confirmations resolved by staff.</p>
      </div>
      <div className="card">
        {(log ?? []).length === 0 ? (
          <div className="empty">No decisions recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Item</th><th>Decision</th><th>Confirmed price</th><th>Dept</th><th>When</th></tr>
              </thead>
              <tbody>
                {log!.map((r: any) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.description}</td>
                    <td>{r.status === "resolved" ? <span className="badge ok">Confirmed</span> : <span className="badge">Dismissed</span>}</td>
                    <td>{r.resolved_price != null ? `${r.currency} ${Number(r.resolved_price).toLocaleString()}` : "—"}</td>
                    <td><span className="badge">{r.department}</span></td>
                    <td className="dim small">{r.resolved_at ? new Date(r.resolved_at).toLocaleString() : "—"}</td>
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
