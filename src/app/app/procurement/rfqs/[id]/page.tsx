/**
 * RFQ detail (§9.2): collect supplier quotations, see them ranked cheapest-first
 * (pure comparison engine), and award the winner. Company-scoped + audited, graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { compareQuotations, type Quotation } from "@/modules/procurement/quote-comparison";
import { addQuotation, awardQuotation } from "../actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "RFQ — Singha Central" };

interface QuoteRow {
  id: string;
  supplierName: string;
  total: string;
  leadTimeDays: number | null;
  isCheapest: boolean;
  rank: number;
  isAwarded: boolean;
}

export default async function RfqDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("procurement");
  const db = supabaseReadClient();

  const { data: rfq } = await db.from("rfqs").select("id, title, description, status").eq("id", params.id).eq("company_id", p.companyId).maybeSingle();
  if (!rfq) notFound();

  const { data: quotes } = await db.from("supplier_quotations")
    .select("id, supplier_name, total_amount, currency, lead_time_days, is_selected")
    .eq("rfq_id", rfq.id).eq("company_id", p.companyId);

  const currency = quotes?.[0]?.currency ?? "LKR";
  const comparison = compareQuotations(
    (quotes ?? []).map((q: any): Quotation => ({ id: q.id, supplierName: q.supplier_name ?? "—", total: String(q.total_amount ?? 0), leadTimeDays: q.lead_time_days })),
    currency,
  );
  const selected = new Set((quotes ?? []).filter((q: any) => q.is_selected).map((q: any) => q.id));

  const rows: QuoteRow[] = comparison.ranked.map((q) => ({
    id: q.id,
    supplierName: q.supplierName,
    total: q.total,
    leadTimeDays: q.leadTimeDays,
    isCheapest: q.isCheapest,
    rank: q.rank,
    isAwarded: selected.has(q.id),
  }));

  const columns: DataTableColumn<QuoteRow>[] = [
    {
      key: "rank",
      header: "#",
      render: (q) => q.isCheapest ? <Badge variant="ok">best</Badge> : <span>{q.rank}</span>,
    },
    {
      key: "supplier",
      header: "Supplier",
      render: (q) => (
        <span style={{ fontWeight: 600 }}>
          {q.supplierName} {q.isAwarded && <Badge variant="accent" style={{ marginLeft: 6 }}>awarded</Badge>}
        </span>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      render: (q) => fmtMoney(q.total, currency),
    },
    {
      key: "lead",
      header: "Lead",
      align: "right",
      render: (q) => q.leadTimeDays != null ? `${fmtNumber(q.leadTimeDays)}d` : "—",
    },
    {
      key: "action",
      header: "",
      render: (q) =>
        !q.isAwarded ? (
          <form action={awardQuotation}>
            <input type="hidden" name="rfq_id" value={rfq.id} />
            <input type="hidden" name="quotation_id" value={q.id} />
            <button className="btn ghost sm" type="submit">Award</button>
          </form>
        ) : null,
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{rfq.title}</h1>
          <p className="muted mt-1"><Badge>{rfq.status}</Badge> {rfq.description ? `· ${rfq.description}` : ""}</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement/rfqs">← RFQs</Link>
      </div>

      {comparison.ranked.length > 1 && (
        <div className="notice ok">Cheapest: <b>{comparison.ranked[0]!.supplierName}</b> · potential saving vs highest: {fmtMoney(comparison.saving, currency)}</div>
      )}

      <Card>
        <CardHeader title="Add supplier quotation" />
        <CardBody>
          <form action={addQuotation} className="row gap-1 wrap mt-2">
            <input type="hidden" name="rfq_id" value={rfq.id} />
            <input name="supplier_name" className="input" style={{ width: 160 }} placeholder="Supplier" required />
            <input name="total_amount" className="input" style={{ width: 130 }} placeholder="Total" inputMode="decimal" />
            <input name="lead_time_days" className="input" style={{ width: 110 }} placeholder="Lead (days)" inputMode="numeric" />
            <input name="notes" className="input" style={{ flex: 1, minWidth: 120 }} placeholder="Notes" />
            <button className="btn ghost sm" type="submit">Add quote</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Quotations (${comparison.ranked.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(q) => q.id}
            emptyTitle="No quotations yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
