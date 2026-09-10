import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { quoteUrl } from "@/lib/quotations";
import { fmtMoney } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { Icon } from "@/components/Icon";
import {
  Card,
  CardBody,
  StatusBadge,
  DataTable,
  type DataTableColumn,
} from "@/components/ui";

export const metadata = { title: "Invoices — Singha Central" };

export default async function InvoicesPage() {
  const p = await requireDepartment("finance");
  const { data: quotes } = await supabaseReadClient()
    .from("quotations")
    .select("id, quote_number, currency, total, status, public_token, sent_at, created_at")
    .eq("company_id", p.companyId)
    .in("status", ["sent", "accepted", "ready"])
    .order("created_at", { ascending: false })
    .limit(200);

  const columns: DataTableColumn<any>[] = [
    { key: "number", header: "Number", render: (q) => <span className="mono" style={{ fontWeight: 600 }}>{q.quote_number}</span> },
    { key: "total", header: "Total", render: (q) => fmtMoney(q.total, q.currency) },
    { key: "status", header: "Status", render: (q) => <StatusBadge status={q.status} /> },
    { key: "sent", header: "Sent", render: (q) => <span className="dim small">{fmtDate(q.sent_at)}</span> },
    {
      key: "action",
      header: "",
      render: (q) => (
        <a className="btn ghost sm" href={quoteUrl(q.public_token)} target="_blank" rel="noreferrer">Open</a>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1>Invoices</h1>
          <p className="muted mt-1">Billing documents generated from finalised quotations.</p>
        </div>
        <a className="btn ghost sm" href="/api/exports/quotations"><Icon name="download" size={15} /> Export to Excel (CSV)</a>
      </div>
      <Card>
        <CardBody>
          <DataTable
            columns={columns}
            rows={quotes ?? []}
            keyExtractor={(q) => q.id}
            emptyTitle="No finalised quotations yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
