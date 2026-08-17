/**
 * Procurement → RFQs (§9.2). Create requests for quotation; compare/award on detail.
 * Company-scoped + audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createRfq } from "./actions";

export const metadata = { title: "RFQs — Singha Central" };

export default async function RfqsPage() {
  const p = await requireDepartment("procurement");

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("rfqs").select("id, title, status, created_at").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div><h1>Requests for Quotation</h1><p className="muted mt-1">Collect supplier quotes and compare before ordering.</p></div>

      <div className="card">
        <div className="card-title">New RFQ</div>
        <form action={createRfq} className="row gap-1 wrap mt-2">
          <input name="title" className="input" style={{ flex: 1, minWidth: 180 }} placeholder="What are you sourcing?" required />
          <input name="description" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Details (optional)" />
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">RFQs ({rows.length})</div>
        {rows.length === 0 ? <div className="empty">No RFQs yet.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Title</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td><span className={`badge ${r.status === "awarded" ? "ok" : r.status === "cancelled" ? "danger" : ""}`}>{r.status}</span></td>
                    <td><Link className="btn ghost sm" href={`/app/procurement/rfqs/${r.id}`}>Open</Link></td>
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
