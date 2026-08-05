/**
 * Customer 360 (§9.1). One customer's profile, invoices (aged) and receipts.
 * Read-only, company-scoped, graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { ageItems, bucketFor, type AgingItem } from "@/modules/finance/aging";

export const metadata = { title: "Customer — Singha" };

const BUCKET_LABEL: Record<string, string> = { current: "current", d1_30: "1–30", d31_60: "31–60", d61_90: "61–90", d90_plus: "90+" };

export default async function CustomerDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("sales");
  const db = supabaseAdmin();
  const now = new Date();

  const { data: c } = await db.from("customers").select("id, name, email, phone, status").eq("id", params.id).eq("company_id", p.companyId).maybeSingle();
  if (!c) notFound();

  const [{ data: invoices }, { data: receipts }] = await Promise.all([
    db.from("customer_invoices").select("id, invoice_number, currency, total_amount, amount_settled, due_date, status").eq("customer_id", c.id).eq("company_id", p.companyId).order("issue_date", { ascending: false }),
    db.from("payments").select("id, amount, currency, payment_date").eq("company_id", p.companyId).eq("party_type", "customer").eq("party_id", c.id).eq("direction", "in").order("payment_date", { ascending: false }).limit(50),
  ]);

  const open = (invoices ?? []).filter((i: any) => !["paid", "cancelled"].includes(i.status));
  const currency = (invoices ?? [])[0]?.currency ?? "LKR";
  const aging = ageItems(open.map((i: any): AgingItem => ({ dueDate: i.due_date, outstanding: String(Number(i.total_amount ?? 0) - Number(i.amount_settled ?? 0)) })), currency, now);
  const m = (v: string | number) => `${currency} ${Number(v).toLocaleString()}`;

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
        <div className="card stat"><div className="k">Outstanding</div><div className="v" style={{ fontSize: "1.4rem", color: Number(aging.total) > 0 ? "var(--warn)" : "var(--ok)" }}>{m(aging.total)}</div></div>
        <div className="card stat"><div className="k">Overdue</div><div className="v" style={{ fontSize: "1.4rem", color: Number(aging.overdue) > 0 ? "var(--danger)" : "var(--ok)" }}>{m(aging.overdue)}</div></div>
        <div className="card stat"><div className="k">90+ days</div><div className="v" style={{ fontSize: "1.4rem" }}>{m(aging.buckets.d90_plus)}</div></div>
      </div>

      <div className="card">
        <div className="card-title">Invoices ({(invoices ?? []).length})</div>
        {(invoices ?? []).length === 0 ? <div className="empty">No invoices.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Number</th><th className="num">Total</th><th className="num">Outstanding</th><th>Age</th><th>Status</th></tr></thead>
              <tbody>
                {(invoices ?? []).map((i: any) => {
                  const outstanding = Number(i.total_amount ?? 0) - Number(i.amount_settled ?? 0);
                  const bucket = ["paid", "cancelled"].includes(i.status) ? null : bucketFor(i.due_date ?? null, now);
                  return (
                    <tr key={i.id}>
                      <td className="mono"><Link href={`/app/finance/customer-invoices/${i.id}`}>{i.invoice_number}</Link></td>
                      <td className="num">{m(i.total_amount)}</td>
                      <td className="num">{outstanding > 0 ? m(outstanding) : "—"}</td>
                      <td>{bucket ? <span className={`badge ${bucket === "d90_plus" ? "danger" : bucket === "current" ? "" : "warn"}`}>{BUCKET_LABEL[bucket]}</span> : "—"}</td>
                      <td><span className={`badge ${i.status === "paid" ? "ok" : ""}`}>{i.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Receipts ({(receipts ?? []).length})</div>
        {(receipts ?? []).length === 0 ? <div className="empty">No receipts recorded.</div> : (
          <div className="stack gap-1 mt-2">
            {(receipts ?? []).map((r: any) => (
              <div key={r.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                <span>{m(r.amount)}</span><span className="dim">{r.payment_date}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
