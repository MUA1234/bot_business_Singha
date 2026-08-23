import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody, Badge, DataTable } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Sales — Singha Central" };

async function count(table: string, companyId: string, extra?: (q: any) => any) {
  let q = supabaseReadClient().from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
  if (extra) q = extra(q);
  const { count } = await q;
  return count ?? 0;
}

interface RecentConversation {
  id: string;
  customer_wa_id: string;
  customer_name: string | null;
  status: string;
  updated_at: string;
}

const CONVO_VARIANT: Record<string, "default" | "info" | "warn" | "ok"> = {
  collecting: "info",
  quoting: "info",
  awaiting_price: "warn",
  quoted: "ok",
};

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

  const recentRows: RecentConversation[] = (recent ?? []) as RecentConversation[];

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
      <Card>
        <CardHeader title="Recent WhatsApp conversations" />
        <CardBody>
          <DataTable
            columns={[
              { key: "customer", header: "Customer", render: (c) => <span style={{ fontWeight: 600 }}>{c.customer_name ?? "—"}</span> },
              { key: "number", header: "Number", render: (c) => <span className="mono dim">+{c.customer_wa_id}</span> },
              {
                key: "status",
                header: "Status",
                render: (c) => (
                  <Badge variant={CONVO_VARIANT[c.status] ?? "default"}>{c.status.replace("_", " ")}</Badge>
                ),
              },
              { key: "updated", header: "Updated", render: (c) => <span className="dim small">{fmtDateTime(c.updated_at)}</span> },
            ]}
            rows={recentRows}
            keyExtractor={(c) => c.id}
            emptyTitle="No conversations yet"
            emptyDescription="They appear when customers message your WhatsApp number."
          />
        </CardBody>
      </Card>
    </div>
  );
}
