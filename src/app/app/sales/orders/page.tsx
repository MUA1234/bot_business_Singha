import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Orders — Singha Central" };

export default async function OrdersPage() {
  const p = await requireDepartment("sales");
  const { data: orders } = await supabaseReadClient()
    .from("orders")
    .select("id, customer_name, customer_phone, customer_address, request_text, status, created_at")
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="stack gap-3">
      <div>
        <h1>Orders</h1>
        <p className="muted mt-1">Captured from WhatsApp order conversations.</p>
      </div>
      <div className="card">
        {(orders ?? []).length === 0 ? (
          <div className="empty">No orders yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Customer</th><th>Contact</th><th>Request</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {orders!.map((o: any) => (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 600 }}>{o.customer_name ?? "—"}</td>
                    <td className="small">
                      <div className="mono dim">{o.customer_phone ?? "—"}</div>
                      <div className="dim">{o.customer_address ?? ""}</div>
                    </td>
                    <td className="small" style={{ maxWidth: 280 }}>{o.request_text ?? "—"}</td>
                    <td><span className="badge">{o.status}</span></td>
                    <td className="dim small">{new Date(o.created_at).toLocaleDateString()}</td>
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
