import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Customers — Singha Central" };

export default async function CustomersPage() {
  const p = await requireDepartment("sales");
  const { data: convos } = await supabaseReadClient()
    .from("wa_conversations")
    .select("id, customer_wa_id, customer_name, status, last_inbound_at, updated_at")
    .eq("company_id", p.companyId)
    .order("updated_at", { ascending: false })
    .limit(200);

  return (
    <div className="stack gap-3">
      <div>
        <h1>Customers</h1>
        <p className="muted mt-1">Everyone who has messaged your WhatsApp number.</p>
      </div>
      <div className="card">
        {(convos ?? []).length === 0 ? (
          <div className="empty">No customer conversations yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Customer</th><th>Number</th><th>Status</th><th>Last message</th><th></th></tr>
              </thead>
              <tbody>
                {convos!.map((c: any) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.customer_name ?? "—"}</td>
                    <td className="mono dim">+{c.customer_wa_id}</td>
                    <td><span className="badge">{c.status.replace("_", " ")}</span></td>
                    <td className="dim small">{c.last_inbound_at ? new Date(c.last_inbound_at).toLocaleString() : "—"}</td>
                    <td><Link className="btn ghost sm" href={`/app/sales/customers/${c.id}`}>View chat</Link></td>
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
