/**
 * Procurement → Purchase Requests. Company-scoped create + status flow (audited).
 * Graceful before the Phase-4 tables exist.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { createPurchaseRequest, setPurchaseRequestStatus } from "./actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Purchase Requests — Singha Central" };

const NEXT: Record<string, string[]> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected"],
  approved: ["ordered"],
  ordered: ["closed"],
  rejected: [],
  closed: [],
};

interface PurchaseRequestRow {
  id: string;
  title: string;
  estimated_cost: string | null;
  currency: string | null;
  status: string;
  created_at: string;
}

export default async function PurchaseRequestsPage() {
  const p = await requireDepartment("procurement");

  let rows: PurchaseRequestRow[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("purchase_requests")
      .select("id, title, estimated_cost, currency, status, created_at")
      .eq("company_id", p.companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    rows = (data ?? []) as PurchaseRequestRow[];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<PurchaseRequestRow>[] = [
    {
      key: "title",
      header: "Request",
      render: (r) => <span style={{ fontWeight: 600 }}>{r.title}</span>,
    },
    {
      key: "estimatedCost",
      header: "Est. cost",
      className: "dim small",
      render: (r) => r.estimated_cost != null ? fmtMoney(r.estimated_cost, r.currency ?? "LKR") : "—",
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge>{r.status}</Badge>,
    },
    {
      key: "created",
      header: "Created",
      className: "dim small",
      render: (r) => fmtDate(r.created_at),
    },
    {
      key: "move",
      header: "Move to",
      render: (r) => {
        const moves = NEXT[r.status] ?? [];
        if (moves.length === 0) return <span className="small dim">—</span>;
        return (
          <div className="row gap-1 wrap">
            {moves.map((s) => (
              <form action={setPurchaseRequestStatus} key={s}>
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="status" value={s} />
                <button className="btn ghost sm" type="submit">{s}</button>
              </form>
            ))}
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Purchase Requests</h1>
        <p className="muted mt-1">Raise a request, then move it through approval to order.</p>
      </div>

      <Card>
        <CardHeader title="New request" />
        <CardBody>
          <form action={createPurchaseRequest} className="stack gap-2 mt-2" style={{ maxWidth: 560 }}>
            <input name="title" className="input" placeholder="What do you need?" required />
            <textarea name="description" className="textarea" placeholder="Details (optional)" />
            <input name="estimated_cost" className="input" style={{ width: 180 }} placeholder="Estimated cost" inputMode="numeric" />
            <button className="btn" type="submit">Create request</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`All requests (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No purchase requests yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
