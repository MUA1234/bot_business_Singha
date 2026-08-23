/**
 * Receivables & Payables drill-down (Architecture V2 change plan §8.3, §10.1: a
 * command-centre card must open the underlying records). Read-only, company-scoped,
 * graceful before the accounting tables carry data. Outstanding = total − settled,
 * bucketed by the pure ageing module. Amounts are decimal strings (Constitution §8).
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { decGtZero, decSub, fmtMoney } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { bucketFor, type AgingBucket } from "@/modules/finance/aging";
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  DataTable,
  type DataTableColumn,
} from "@/components/ui";

export const metadata = { title: "Receivables & Payables — Singha Central" };

const BUCKET_LABEL: Record<AgingBucket, string> = {
  current: "current",
  d1_30: "1–30",
  d31_60: "31–60",
  d61_90: "61–90",
  d90_plus: "90+",
};
const BUCKET_RANK: Record<AgingBucket, number> = { d90_plus: 0, d61_90: 1, d31_60: 2, d1_30: 3, current: 4 };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

interface Row {
  ref: string;
  party: string;
  currency: string;
  outstanding: string; // exact decimal string — never a JS float
  dueDate: string | null;
  bucket: AgingBucket;
}

function toRows(records: any[], refKey: string, partyName: (r: any) => string, now: Date): Row[] {
  return records
    .map((r) => {
      const outstanding = decSub(r.total_amount, r.amount_settled).toFixed();
      return {
        ref: r[refKey] ?? "—",
        party: partyName(r),
        currency: r.currency ?? "LKR",
        outstanding,
        dueDate: r.due_date ?? null,
        bucket: bucketFor(r.due_date ?? null, now),
      };
    })
    .filter((r) => decGtZero(r.outstanding))
    .sort((a, b) => BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]);
}

function Table({ title, rows }: { title: string; rows: Row[] }) {
  type KeyedRow = Row & { key: string };
  const keyedRows: KeyedRow[] = rows.map((r, i) => ({ ...r, key: `${title}-${i}` }));
  const columns: DataTableColumn<KeyedRow>[] = [
    { key: "ref", header: "Ref", render: (r) => <span className="mono">{r.ref}</span> },
    { key: "party", header: "Party", render: (r) => r.party },
    { key: "due", header: "Due", render: (r) => <span className="dim small">{fmtDate(r.dueDate)}</span> },
    { key: "outstanding", header: "Outstanding", align: "right", render: (r) => fmtMoney(r.outstanding, r.currency) },
    {
      key: "age",
      header: "Age",
      render: (r) => (
        <Badge variant={r.bucket === "d90_plus" ? "danger" : r.bucket === "current" ? "default" : "warn"}>
          {BUCKET_LABEL[r.bucket]}
        </Badge>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader title={`${title} (${rows.length})`} />
      <CardBody>
        <DataTable
          columns={columns}
          rows={keyedRows}
          keyExtractor={(r) => r.key}
          emptyTitle="Nothing outstanding"
          className="mt-3"
        />
      </CardBody>
    </Card>
  );
}

export default async function ReceivablesPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const now = new Date();

  const [invoices, bills] = await Promise.all([
    safe<any>(() =>
      db.from("customer_invoices")
        .select("invoice_number, total_amount, amount_settled, currency, due_date, status, customers(name)")
        .eq("company_id", p.companyId).not("status", "in", "(paid,cancelled)") as any,
    ),
    safe<any>(() =>
      db.from("supplier_bills")
        .select("bill_number, total_amount, amount_settled, currency, due_date, status, suppliers(name)")
        .eq("company_id", p.companyId).not("status", "in", "(paid,cancelled)") as any,
    ),
  ]);

  const ar = toRows(invoices, "invoice_number", (r) => r.customers?.name ?? "—", now);
  const ap = toRows(bills, "bill_number", (r) => r.suppliers?.name ?? "—", now);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Receivables &amp; Payables</h1>
          <p className="muted mt-1">Outstanding balances, aged. 90+ days flagged red.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance">← Finance</Link>
      </div>
      <Table title="Receivables (money in)" rows={ar} />
      <Table title="Payables (money out)" rows={ap} />
    </div>
  );
}
