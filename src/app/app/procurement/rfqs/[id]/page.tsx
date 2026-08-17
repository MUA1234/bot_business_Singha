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

export const metadata = { title: "RFQ — Singha" };

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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{rfq.title}</h1>
          <p className="muted mt-1"><span className="badge">{rfq.status}</span> {rfq.description ? `· ${rfq.description}` : ""}</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement/rfqs">← RFQs</Link>
      </div>

      {comparison.ranked.length > 1 && (
        <div className="notice ok">Cheapest: <b>{comparison.ranked[0]!.supplierName}</b> · potential saving vs highest: {fmtMoney(comparison.saving, currency)}</div>
      )}

      <div className="card">
        <div className="card-title">Add supplier quotation</div>
        <form action={addQuotation} className="row gap-1 wrap mt-2">
          <input type="hidden" name="rfq_id" value={rfq.id} />
          <input name="supplier_name" className="input" style={{ width: 160 }} placeholder="Supplier" required />
          <input name="total_amount" className="input" style={{ width: 130 }} placeholder="Total" inputMode="decimal" />
          <input name="lead_time_days" className="input" style={{ width: 110 }} placeholder="Lead (days)" inputMode="numeric" />
          <input name="notes" className="input" style={{ flex: 1, minWidth: 120 }} placeholder="Notes" />
          <button className="btn ghost sm" type="submit">Add quote</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Quotations ({comparison.ranked.length})</div>
        {comparison.ranked.length === 0 ? <div className="empty">No quotations yet.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>#</th><th>Supplier</th><th className="num">Total</th><th className="num">Lead</th><th></th></tr></thead>
              <tbody>
                {comparison.ranked.map((q) => (
                  <tr key={q.id}>
                    <td>{q.isCheapest ? <span className="badge ok">best</span> : q.rank}</td>
                    <td style={{ fontWeight: 600 }}>{q.supplierName} {selected.has(q.id) && <span className="badge accent" style={{ marginLeft: 6 }}>awarded</span>}</td>
                    <td className="num">{fmtMoney(q.total, currency)}</td>
                    <td className="num">{q.leadTimeDays != null ? `${q.leadTimeDays}d` : "—"}</td>
                    <td>
                      {!selected.has(q.id) && (
                        <form action={awardQuotation}>
                          <input type="hidden" name="rfq_id" value={rfq.id} />
                          <input type="hidden" name="quotation_id" value={q.id} />
                          <button className="btn ghost sm" type="submit">Award</button>
                        </form>
                      )}
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
