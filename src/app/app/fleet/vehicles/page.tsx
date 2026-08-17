/**
 * Fleet → Vehicles. Company-scoped create + list (audited). Graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createVehicle } from "./actions";

export const metadata = { title: "Vehicles — Singha Central" };

export default async function VehiclesPage() {
  const p = await requireDepartment("fleet");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("vehicles")
      .select("id, registration_no, make, model, year, status, odometer")
      .eq("company_id", p.companyId)
      .order("registration_no")
      .limit(300);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Vehicles</h1>
          <p className="muted mt-1">Your fleet register.</p>
        </div>
        <Link className="btn ghost sm" href="/app/fleet">← Fleet</Link>
      </div>

      <div className="card">
        <div className="card-title">Add vehicle</div>
        <form action={createVehicle} className="row gap-1 wrap mt-2">
          <input name="registration_no" className="input" style={{ width: 150 }} placeholder="Reg. no" required />
          <input name="make" className="input" style={{ width: 130 }} placeholder="Make" />
          <input name="model" className="input" style={{ width: 130 }} placeholder="Model" />
          <input name="year" className="input" style={{ width: 90 }} placeholder="Year" inputMode="numeric" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Fleet ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No vehicles yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Reg. no</th><th>Vehicle</th><th>Year</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.registration_no}</td>
                    <td>{[r.make, r.model].filter(Boolean).join(" ") || "—"}</td>
                    <td className="dim small">{r.year ?? "—"}</td>
                    <td><span className="badge">{r.status}</span></td>
                    <td><Link className="btn ghost sm" href={`/app/fleet/vehicles/${r.id}`}>Open</Link></td>
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
