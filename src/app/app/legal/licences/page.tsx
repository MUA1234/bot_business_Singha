/**
 * Legal → Licences (§9.3). Company-scoped create + list; expiry flags feed the legal
 * renewals dashboard. Audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { EmptyState } from "@/components/ui/EmptyState";

import { supabaseReadClient } from "@/lib/supabase/read";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { createLicence } from "./actions";

export const metadata = { title: "Licences — Singha Central" };

export default async function LicencesPage() {
  const p = await requireDepartment("legal");
  const now = new Date();

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("licences").select("id, name, authority, licence_number, expiry_date, status").eq("company_id", p.companyId).order("expiry_date", { ascending: true, nullsFirst: false }).limit(300)).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Licences &amp; Permits</h1><p className="muted mt-1">Renewals are flagged on the Legal overview.</p></div>
        <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
      </div>

      <div className="card">
        <div className="card-title">New licence</div>
        <form action={createLicence} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Licence / permit name" required />
          <input name="authority" className="input" style={{ width: 150 }} placeholder="Authority" />
          <input name="licence_number" className="input" style={{ width: 130 }} placeholder="Number" />
          <label className="small dim">Expiry <input name="expiry_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Licences ({rows.length})</div>
        {rows.length === 0 ? <EmptyState title="No licences yet." icon="file-text" /> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Name</th><th>Authority</th><th>Number</th><th>Expiry</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const s = renewalStatus(r.expiry_date ?? null, now, 45);
                  const b = s === "expired" ? "danger" : s === "due_soon" ? "warn" : "";
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      <td className="dim small">{r.authority ?? "—"}</td>
                      <td className="mono dim small">{r.licence_number ?? "—"}</td>
                      <td>{r.expiry_date ? <span className={`badge ${b}`}>{r.expiry_date}</span> : <span className="dim small">—</span>}</td>
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
