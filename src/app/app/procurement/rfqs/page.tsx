/**
 * Procurement → RFQs (§9.2). Create requests for quotation; compare/award on detail.
 * Company-scoped + audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createRfq } from "./actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "RFQs — Singha Central" };

interface RfqRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

export default async function RfqsPage() {
  const p = await requireDepartment("procurement");

  let rows: RfqRow[] = [];
  try {
    rows = ((await supabaseReadClient().from("rfqs").select("id, title, status, created_at").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200)).data ?? []) as RfqRow[];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<RfqRow>[] = [
    {
      key: "title",
      header: "Title",
      render: (r) => <span style={{ fontWeight: 600 }}>{r.title}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge variant={r.status === "awarded" ? "ok" : r.status === "cancelled" ? "danger" : "default"}>{r.status}</Badge>,
    },
    {
      key: "created",
      header: "Created",
      className: "dim small",
      render: (r) => fmtDate(r.created_at),
    },
    {
      key: "open",
      header: "",
      render: (r) => <Link className="btn ghost sm" href={`/app/procurement/rfqs/${r.id}`}>Open</Link>,
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Requests for Quotation</h1>
        <p className="muted mt-1">Collect supplier quotes and compare before ordering.</p>
      </div>

      <Card>
        <CardHeader title="New RFQ" />
        <CardBody>
          <form action={createRfq} className="row gap-1 wrap mt-2">
            <input name="title" className="input" style={{ flex: 1, minWidth: 180 }} placeholder="What are you sourcing?" required />
            <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Details (optional)" />
            <button className="btn" type="submit">Create</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`RFQs (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No RFQs yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
