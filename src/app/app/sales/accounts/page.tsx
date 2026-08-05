/**
 * Sales → Customer Accounts (§9.1). Each customer with their invoice count and total
 * outstanding (from customer_invoices). Click through to a 360 view. Read-only,
 * company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Customer Accounts — Singha" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function AccountsPage() {
  const p = await requireDepartment("sales");
  const db = supabaseAdmin();

  const [customers, invoices] = await Promise.all([
    safe<any>(() => db.from("customers").select("id, name, email, phone").eq("company_id", p.companyId).order("name").limit(500) as any),
    safe<any>(() => db.from("customer_invoices").select("customer_id, currency, total_amount, amount_settled, status").eq("company_id", p.companyId).not("status", "in", "(paid,cancelled)") as any),
  ]);

  const outByCustomer = new Map<string, { outstanding: number; count: number; currency: string }>();
  for (const inv of invoices) {
    const cur = outByCustomer.get(inv.customer_id) ?? { outstanding: 0, count: 0, currency: inv.currency ?? "LKR" };
    cur.outstanding += Number(inv.total_amount ?? 0) - Number(inv.amount_settled ?? 0);
    cur.count += 1;
    outByCustomer.set(inv.customer_id, cur);
  }

  const rows = customers
    .map((c) => ({ ...c, agg: outByCustomer.get(c.id) ?? { outstanding: 0, count: 0, currency: "LKR" } }))
    .sort((a, b) => b.agg.outstanding - a.agg.outstanding);

  return (
    <div className="stack gap-3">
      <div><h1>Customer Accounts</h1><p className="muted mt-1">Everyone you invoice, with what they owe.</p></div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No customers yet — they're created when you raise an invoice.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Customer</th><th>Contact</th><th className="num">Open invoices</th><th className="num">Outstanding</th><th></th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td className="dim small">{c.email ?? c.phone ?? "—"}</td>
                    <td className="num">{c.agg.count}</td>
                    <td className="num" style={{ color: c.agg.outstanding > 0 ? "var(--warn)" : undefined }}>{c.agg.currency} {c.agg.outstanding.toLocaleString()}</td>
                    <td><Link className="btn ghost sm" href={`/app/sales/accounts/${c.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
