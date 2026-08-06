/**
 * Fleet → Drivers (§9.4). Company-scoped create + list with licence-expiry flags.
 * Audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { createDriver } from "../vehicles/actions";

export const metadata = { title: "Drivers — Singha" };

export default async function DriversPage() {
  const p = await requireDepartment("fleet");
  const now = new Date();

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("drivers").select("id, name, licence_number, licence_expiry, phone, status").eq("company_id", p.companyId).order("name").limit(300)).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Drivers</h1>
          <p className="muted mt-1">Driver roster and licence expiry.</p>
        </div>
        <Link className="btn ghost sm" href="/app/fleet">← Fleet</Link>
      </div>

      <div className="card">
        <div className="card-title">Add driver</div>
        <form action={createDriver} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Name" required />
          <input name="licence_number" className="input" style={{ width: 140 }} placeholder="Licence no" />
          <label className="small dim">Expiry <input name="licence_expiry" type="date" className="input" style={{ width: 150 }} /></label>
          <input name="phone" className="input" style={{ width: 140 }} placeholder="Phone" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Drivers ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No drivers yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Name</th><th>Licence</th><th>Expiry</th><th>Phone</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const s = renewalStatus(r.licence_expiry ?? null, now, 30);
                  const b = s === "expired" ? "danger" : s === "due_soon" ? "warn" : "";
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      <td className="mono dim small">{r.licence_number ?? "—"}</td>
                      <td>{r.licence_expiry ? <span className={`badge ${b}`}>{r.licence_expiry}</span> : <span className="dim small">—</span>}</td>
                      <td className="dim small">{r.phone ?? "—"}</td>
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
