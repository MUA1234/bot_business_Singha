import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { quoteUrl } from "@/lib/quotations";
import { Icon } from "@/components/Icon";

export const metadata = { title: "Invoices — Singha" };

export default async function InvoicesPage() {
  const p = await requireDepartment("finance");
  const { data: quotes } = await supabaseAdmin()
    .from("quotations")
    .select("id, quote_number, currency, total, status, public_token, sent_at, created_at")
    .eq("company_id", p.companyId)
    .in("status", ["sent", "accepted", "ready"])
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1>Invoices</h1>
          <p className="muted mt-1">Billing documents generated from finalised quotations.</p>
        </div>
        <a className="btn ghost sm" href="/api/exports/quotations"><Icon name="download" size={15} /> Export to Excel (CSV)</a>
      </div>
      <div className="card">
        {(quotes ?? []).length === 0 ? (
          <div className="empty">No finalised quotations yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Number</th><th>Total</th><th>Status</th><th>Sent</th><th></th></tr>
              </thead>
              <tbody>
                {quotes!.map((q: any) => (
                  <tr key={q.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{q.quote_number}</td>
                    <td>{q.currency} {Number(q.total).toLocaleString()}</td>
                    <td><span className="badge ok">{q.status}</span></td>
                    <td className="dim small">{q.sent_at ? new Date(q.sent_at).toLocaleDateString() : "—"}</td>
                    <td><a className="btn ghost sm" href={quoteUrl(q.public_token)} target="_blank" rel="noreferrer">Open</a></td>
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
