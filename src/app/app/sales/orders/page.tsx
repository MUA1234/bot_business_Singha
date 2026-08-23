import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardBody, StatusBadge, DataTable } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Orders — Singha Central" };

interface Order {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  request_text: string | null;
  status: string;
  created_at: string;
}

export default async function OrdersPage() {
  const p = await requireDepartment("sales");
  const { data: orders } = await supabaseReadClient()
    .from("orders")
    .select("id, customer_name, customer_phone, customer_address, request_text, status, created_at")
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: false })
    .limit(100);

  const rows: Order[] = (orders ?? []) as Order[];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Orders</h1>
        <p className="muted mt-1">Captured from WhatsApp order conversations.</p>
      </div>
      <Card>
        <CardBody>
          <DataTable
            columns={[
              { key: "customer", header: "Customer", render: (o) => <span style={{ fontWeight: 600 }}>{o.customer_name ?? "—"}</span> },
              {
                key: "contact",
                header: "Contact",
                render: (o) => (
                  <div className="small">
                    <div className="mono dim">{o.customer_phone ?? "—"}</div>
                    <div className="dim">{o.customer_address ?? ""}</div>
                  </div>
                ),
              },
              { key: "request", header: "Request", className: "small", render: (o) => <span style={{ maxWidth: 280 }}>{o.request_text ?? "—"}</span> },
              { key: "status", header: "Status", render: (o) => <StatusBadge status={o.status} /> },
              { key: "created", header: "Created", render: (o) => <span className="dim small">{fmtDate(o.created_at)}</span> },
            ]}
            rows={rows}
            keyExtractor={(o) => o.id}
            emptyTitle="No orders yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
