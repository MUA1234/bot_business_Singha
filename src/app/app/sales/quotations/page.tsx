import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { quoteUrl } from "@/lib/quotations";
import { fmtMoney } from "@/lib/money";

export const metadata = { title: "Quotations — Singha" };

const STATUS_CLASS: Record<string, string> = {
  draft: "",
  awaiting_price: "warn",
  ready: "info",
  sent: "ok",
  accepted: "ok",
  rejected: "danger",
};

export default async function QuotationsPage() {
  const p = await requireDepartment("sales");
  const { data: quotes } = await supabaseReadClient()
    .from("quotations")
    .select("id, quote_number, currency, total, status, public_token, created_at, order_id")
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: false })
    .limit(100);

  const orderIds = Array.from(new Set((quotes ?? []).map((q: any) => q.order_id).filter(Boolean)));
  const names = new Map<string, string>();
  if (orderIds.length) {
    const { data: orders } = await supabaseReadClient().from("orders").select("id, customer_name").in("id", orderIds);
    for (const o of orders ?? []) names.set(o.id, o.customer_name ?? "");
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Quotations</h1>
        <p className="muted mt-1">Auto-generated from orders. Open a quotation to view the branded document.</p>
      </div>
      <div className="card">
        {(quotes ?? []).length === 0 ? (
          <div className="empty">No quotations yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Number</th><th>Customer</th><th>Total</th><th>Status</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {quotes!.map((q: any) => (
                  <tr key={q.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{q.quote_number}</td>
                    <td>{names.get(q.order_id) || "—"}</td>
                    <td>{fmtMoney(q.total, q.currency)}</td>
                    <td><span className={`badge ${STATUS_CLASS[q.status] ?? ""}`}>{q.status.replace("_", " ")}</span></td>
                    <td className="dim small">{new Date(q.created_at).toLocaleDateString()}</td>
                    <td>
                      <a className="btn ghost sm" href={quoteUrl(q.public_token)} target="_blank" rel="noreferrer">Open</a>
                    </td>
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
