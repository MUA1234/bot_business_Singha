/**
 * Finance → Journals (§8.1/§8.2). Lists posted journals. Posted entries are
 * immutable. Read-only list; company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody, Button, StatusBadge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Journals — Singha Central" };

export default async function JournalsPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("journal_entries")
      .select("id, posting_date, currency, memo, status, total_debit, total_credit")
      .eq("company_id", p.companyId)
      .order("posting_date", { ascending: false })
      .limit(200);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    { key: "date", header: "Date", render: (r) => <span className="dim small">{fmtDate(r.posting_date)}</span> },
    { key: "memo", header: "Memo", render: (r) => r.memo ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "debit", header: "Debit", align: "right", render: (r) => fmtMoney(r.total_debit, r.currency) },
    { key: "credit", header: "Credit", align: "right", render: (r) => fmtMoney(r.total_credit, r.currency) },
    { key: "action", header: "", render: (r) => <Link className="btn ghost sm" href={`/app/finance/journals/${r.id}`}>View</Link> },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Journals</h1>
          <p className="muted mt-1">Posted double-entry journals — the accounting source of truth.</p>
        </div>
        <div className="row gap-1 wrap">
          <Link className="btn ghost sm" href="/app/finance/trial-balance">Trial balance</Link>
          <Link className="btn sm" href="/app/finance/journals/new">New journal</Link>
        </div>
      </div>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="No journals yet"
            action={{ label: "Post one", href: "/app/finance/journals/new" }}
          />
        ) : (
          <DataTable columns={columns} rows={rows} keyExtractor={(r) => r.id} />
        )}
      </Card>
    </div>
  );
}
