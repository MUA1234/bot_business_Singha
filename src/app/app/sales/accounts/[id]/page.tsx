/**
 * Customer 360 (§9.1). One customer's profile, invoices (aged) and receipts.
 * Read-only, company-scoped, graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { decGtZero, decSub, fmtMoney } from "@/lib/money";
import { ageItems, bucketFor, type AgingItem } from "@/modules/finance/aging";
import { Card, CardHeader, CardBody, Badge, StatusBadge, DataTable, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Customer — Singha Central" };

const BUCKET_LABEL: Record<string, string> = { current: "current", d1_30: "1–30", d31_60: "31–60", d61_90: "61–90", d90_plus: "90+" };
const BUCKET_VARIANT: Record<string, "default" | "warn" | "danger"> = {
  current: "default",
  d1_30: "warn",
  d31_60: "warn",
  d61_90: "warn",
  d90_plus: "danger",
};

interface Invoice {
  id: string;
  invoice_number: string;
  currency: string;
  total_amount: string;
  amount_settled: string;
  due_date: string | null;
  status: string;
}

interface Receipt {
  id: string;
  amount: string;
  currency: string;
  payment_date: string;
}

export default async function CustomerDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("sales");
  const db = supabaseReadClient();
  const now = new Date();

  const { data: c } = await db.from("customers").select("id, name, email, phone, status").eq("id", params.id).eq("company_id", p.companyId).maybeSingle();
  if (!c) notFound();

  const [{ data: invoices }, { data: receipts }] = await Promise.all([
    db.from("customer_invoices").select("id, invoice_number, currency, total_amount, amount_settled, due_date, status").eq("customer_id", c.id).eq("company_id", p.companyId).order("issue_date", { ascending: false }),
    db.from("payments").select("id, amount, currency, payment_date").eq("company_id", p.companyId).eq("party_type", "customer").eq("party_id", c.id).eq("direction", "in").order("payment_date", { ascending: false }).limit(50),
  ]);

  const invoiceRows: Invoice[] = (invoices ?? []) as Invoice[];
  const receiptRows: Receipt[] = (receipts ?? []) as Receipt[];

  const open = invoiceRows.filter((i) => !["paid", "cancelled"].includes(i.status));
  const currency = invoiceRows[0]?.currency ?? "LKR";
  const aging = ageItems(open.map((i): AgingItem => ({ dueDate: i.due_date, outstanding: decSub(i.total_amount, i.amount_settled).toFixed() })), currency, now);
  const m = (v: unknown) => fmtMoney(v, currency);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{c.name}</h1>
          <p className="muted mt-1">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</p>
        </div>
        <Link className="btn ghost sm" href="/app/sales/accounts">← Accounts</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Outstanding</div><div className="v" style={{ fontSize: "1.4rem", color: decGtZero(aging.total) ? "var(--warn)" : "var(--ok)" }}>{m(aging.total)}</div></div>
        <div className="card stat"><div className="k">Overdue</div><div className="v" style={{ fontSize: "1.4rem", color: decGtZero(aging.overdue) ? "var(--danger)" : "var(--ok)" }}>{m(aging.overdue)}</div></div>
        <div className="card stat"><div className="k">90+ days</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(aging.buckets.d90_plus)}</div></div>
      </div>

      <Card>
        <CardHeader title={`Invoices (${invoiceRows.length})`} />
        <CardBody>
          {invoiceRows.length === 0 ? (
            <EmptyState title="No invoices" icon="inbox" />
          ) : (
            <DataTable
              columns={[
                { key: "number", header: "Number", render: (i) => <span className="mono"><Link href={`/app/finance/customer-invoices/${i.id}`}>{i.invoice_number}</Link></span> },
                { key: "total", header: "Total", align: "right", render: (i) => m(i.total_amount) },
                {
                  key: "outstanding",
                  header: "Outstanding",
                  align: "right",
                  render: (i) => {
                    const outstanding = decSub(i.total_amount, i.amount_settled);
                    return outstanding.greaterThan(0) ? m(outstanding) : "—";
                  },
                },
                {
                  key: "age",
                  header: "Age",
                  render: (i) => {
                    const bucket = ["paid", "cancelled"].includes(i.status) ? null : bucketFor(i.due_date ?? null, now);
                    return bucket ? <Badge variant={BUCKET_VARIANT[bucket] ?? "default"}>{BUCKET_LABEL[bucket]}</Badge> : "—";
                  },
                },
                { key: "status", header: "Status", render: (i) => <StatusBadge status={i.status} /> },
              ]}
              rows={invoiceRows}
              keyExtractor={(i) => i.id}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Receipts (${receiptRows.length})`} />
        <CardBody>
          <DataTable
            columns={[
              { key: "amount", header: "Amount", render: (r) => m(r.amount) },
              { key: "date", header: "Date", render: (r) => <span className="dim small">{fmtDate(r.payment_date)}</span> },
            ]}
            rows={receiptRows}
            keyExtractor={(r) => r.id}
            emptyTitle="No receipts recorded"
          />
        </CardBody>
      </Card>
    </div>
  );
}
