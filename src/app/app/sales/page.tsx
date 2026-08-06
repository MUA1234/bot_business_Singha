import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Sales — Singha" };

async function count(table: string, companyId: string, extra?: (q: any) => any) {
  let q = supabaseReadClient().from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
  if (extra) q = extra(q);
  const { count } = await q;
  return count ?? 0;
}

export default async function SalesHome() {
  const p = await requireDepartment("sales");
  const [newOrders, quotes, openPrice, convos] = await Promise.all([
    count("orders", p.companyId, (q) => q.eq("status", "new")),
    count("quotations", p.companyId),
    count("price_confirmations", p.companyId, (q) => q.eq("status", "open")),
    count("wa_conversations", p.companyId),
  ]);

  const { data: recent } = await supabaseReadClient()
    .from("wa_conversations")
    .select("id, customer_wa_id, customer_name, status, updated_at")
    .eq("company_id", p.companyId)
    .order("updated_at", { ascending: false })
    .limit(6);

  const tiles = [
    { k: "New orders", v: newOrders, href: "/app/sales/orders" },
    { k: "Quotations", v: quotes, href: "/app/sales/quotations" },
    { k: "Price confirmations", v: openPrice, href: "/app/sales/price-requests" },
    { k: "Conversations", v: convos, href: "/app/sales/customers" },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Sales &amp; Orders</h1>
        <p className="muted mt-1">WhatsApp orders flow in here and turn into quotations automatically.</p>
      </div>
      <div className="grid cols-4">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v">{t.v}</div>
          </Link>
        ))}
      </div>
      <div className="card">
        <div className="card-title">Recent WhatsApp conversations</div>
        {(recent ?? []).length === 0 ? (
          <div className="empty">No conversations yet. They appear when customers message your WhatsApp number.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Customer</th><th>Number</th><th>Status</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {recent!.map((c: any) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.customer_name ?? "—"}</td>
                    <td className="mono dim">+{c.customer_wa_id}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="dim small">{new Date(c.updated_at).toLocaleString()}</td>
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    collecting: "info",
    quoting: "info",
    awaiting_price: "warn",
    quoted: "ok",
    closed: "",
  };
  return <span className={`badge ${map[status] ?? ""}`}>{status.replace("_", " ")}</span>;
}
