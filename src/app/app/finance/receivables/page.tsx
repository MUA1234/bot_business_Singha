/**
 * Receivables & Payables drill-down (Architecture V2 change plan §8.3, §10.1: a
 * command-centre card must open the underlying records). Read-only, company-scoped,
 * graceful before the accounting tables carry data. Outstanding = total − settled,
 * bucketed by the pure ageing module. Amounts are decimal strings (Constitution §8).
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { bucketFor, type AgingBucket } from "@/modules/finance/aging";

export const metadata = { title: "Receivables & Payables — Singha" };

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
  outstanding: number;
  dueDate: string | null;
  bucket: AgingBucket;
}

function toRows(records: any[], refKey: string, partyName: (r: any) => string, now: Date): Row[] {
  return records
    .map((r) => {
      const outstanding = Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0);
      return {
        ref: r[refKey] ?? "—",
        party: partyName(r),
        currency: r.currency ?? "LKR",
        outstanding,
        dueDate: r.due_date ?? null,
        bucket: bucketFor(r.due_date ?? null, now),
      };
    })
    .filter((r) => r.outstanding > 0.000001)
    .sort((a, b) => BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]);
}

function Table({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="card">
      <div className="card-title">{title} ({rows.length})</div>
      {rows.length === 0 ? (
        <div className="empty">Nothing outstanding.</div>
      ) : (
        <div className="table-wrap mt-3">
          <table className="data">
            <thead>
              <tr><th>Ref</th><th>Party</th><th>Due</th><th className="num">Outstanding</th><th>Age</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.ref}</td>
                  <td>{r.party}</td>
                  <td className="dim small">{r.dueDate ?? "—"}</td>
                  <td className="num">{r.currency} {r.outstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td><span className={`badge ${r.bucket === "d90_plus" ? "danger" : r.bucket === "current" ? "" : "warn"}`}>{BUCKET_LABEL[r.bucket]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default async function ReceivablesPage() {
  const p = await requireDepartment("finance");
  const db = supabaseAdmin();
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
