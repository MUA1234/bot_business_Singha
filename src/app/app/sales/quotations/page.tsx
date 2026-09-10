import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { quoteUrl } from "@/lib/quotations";
import { fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, Badge, DataTable } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Quotations — Singha Central" };

const STATUS_VARIANT: Record<string, "default" | "info" | "warn" | "ok" | "danger"> = {
  draft: "default",
  awaiting_price: "warn",
  ready: "info",
  sent: "ok",
  accepted: "ok",
  rejected: "danger",
};

interface Quotation {
  id: string;
  quote_number: string;
  currency: string;
  total: string;
  status: string;
  public_token: string;
  created_at: string;
  order_id: string | null;
}

export default async function QuotationsPage() {
  const p = await requireDepartment("sales");
  const { data: quotes } = await supabaseReadClient()
    .from("quotations")
    .select("id, quote_number, currency, total, status, public_token, created_at, order_id")
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: false })
    .limit(100);

  const rows: Quotation[] = (quotes ?? []) as Quotation[];

  const orderIds = Array.from(new Set(rows.map((q) => q.order_id).filter(Boolean)));
  const names = new Map<string, string>();
  if (orderIds.length) {
    const { data: orders } = await supabaseReadClient().from("orders").select("id, customer_name").in("id", orderIds);
    for (const o of orders ?? []) names.set(o.id, o.customer_name ?? "");
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Quotations</h1>
        <p className="muted mt-1">Auto-generated from orders. Open a quotation to view the branded document.</p>
      </div>
      <Card>
        <CardHeader title="Quotations" />
        <CardBody>
          <DataTable
            columns={[
              { key: "number", header: "Number", render: (q) => <span className="mono" style={{ fontWeight: 600 }}>{q.quote_number}</span> },
              { key: "customer", header: "Customer", render: (q) => names.get(q.order_id ?? "") || "—" },
              { key: "total", header: "Total", render: (q) => fmtMoney(q.total, q.currency) },
              {
                key: "status",
                header: "Status",
                render: (q) => <Badge variant={STATUS_VARIANT[q.status] ?? "default"}>{q.status.replace("_", " ")}</Badge>,
              },
              { key: "created", header: "Created", render: (q) => <span className="dim small">{fmtDate(q.created_at)}</span> },
              {
                key: "action",
                header: "",
                render: (q) => (
                  <a className="btn ghost sm" href={quoteUrl(q.public_token)} target="_blank" rel="noreferrer">Open</a>
                ),
              },
            ]}
            rows={rows}
            keyExtractor={(q) => q.id}
            emptyTitle="No quotations yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
