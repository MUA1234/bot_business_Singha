/**
 * Legal → Contracts. Company-scoped create + list with renewal dates (audited).
 * Graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { EmptyState } from "@/components/ui/EmptyState";

import { supabaseReadClient } from "@/lib/supabase/read";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { createContract } from "./actions";

export const metadata = { title: "Contracts — Singha Central" };

export default async function ContractsPage() {
  const p = await requireDepartment("legal");
  const now = new Date();

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("contracts")
      .select("id, title, counterparty, end_date, renewal_date, status")
      .eq("company_id", p.companyId)
      .order("renewal_date", { ascending: true, nullsFirst: false })
      .limit(200);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Contracts</h1>
          <p className="muted mt-1">Agreements and their renewal dates.</p>
        </div>
        <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
      </div>

      <div className="card">
        <div className="card-title">New contract</div>
        <form action={createContract} className="row gap-1 wrap mt-2">
          <input name="title" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Contract title" required />
          <input name="counterparty" className="input" style={{ flex: 1, minWidth: 130 }} placeholder="Counterparty" />
          <label className="small dim">Renewal <input name="renewal_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All contracts ({rows.length})</div>
        {rows.length === 0 ? (
          <EmptyState title="No contracts yet." icon="file-text" />
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Contract</th><th>Counterparty</th><th>Renewal</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const st = renewalStatus(r.renewal_date ?? null, now, 45);
                  const badge = st === "expired" ? "danger" : st === "due_soon" ? "warn" : "";
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.title}</td>
                      <td className="dim small">{r.counterparty ?? "—"}</td>
                      <td>{r.renewal_date ? <span className={`badge ${badge}`}>{r.renewal_date}</span> : <span className="dim small">—</span>}</td>
                      <td><span className="badge">{r.status}</span></td>
                      <td><Link className="btn ghost sm" href={`/app/legal/contracts/${r.id}`}>Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
