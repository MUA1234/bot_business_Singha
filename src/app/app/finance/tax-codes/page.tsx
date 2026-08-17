/**
 * Finance → Tax Codes (§8.3). Company-scoped create + list of tax rates. Audited,
 * graceful.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { taxAmount } from "@/accounting/tax";
import { fmtMoney } from "@/lib/money";
import { createTaxCode } from "./actions";

export const metadata = { title: "Tax Codes — Singha Central" };

export default async function TaxCodesPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("tax_codes").select("id, code, name, rate, is_active").eq("company_id", p.companyId).order("code").limit(100)).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div><h1>Tax Codes</h1><p className="muted mt-1">Rates used on invoices and bills.</p></div>

      <div className="card">
        <div className="card-title">New tax code</div>
        <form action={createTaxCode} className="row gap-1 wrap mt-2">
          <input name="code" className="input" style={{ width: 110 }} placeholder="Code (VAT)" required />
          <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Name" required />
          <input name="rate" className="input" style={{ width: 100 }} placeholder="Rate %" inputMode="decimal" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Tax codes ({rows.length})</div>
        {rows.length === 0 ? <div className="empty">No tax codes yet.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Code</th><th>Name</th><th className="num">Rate</th><th className="num">Tax on 1,000</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.code}</td>
                    <td>{r.name}</td>
                    <td className="num">{Number(r.rate)}%</td>
                    <td className="num dim">{fmtMoney(taxAmount("1000", Number(r.rate), "LKR"))}</td>
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
