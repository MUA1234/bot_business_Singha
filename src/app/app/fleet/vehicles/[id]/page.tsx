/**
 * Vehicle detail (§9.4): documents (feed renewal alerts), maintenance, fuel logs with
 * computed efficiency, and trips. Company-scoped + audited; graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { fuelEfficiency, type FuelLog } from "@/modules/fleet/fuel-efficiency";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { addVehicleDocument, addMaintenance, addFuelLog, addTrip } from "../actions";

export const metadata = { title: "Vehicle — Singha Central" };
const DOC_TYPES = ["insurance", "registration", "emission", "permit", "other"];

export default async function VehicleDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("fleet");
  const db = supabaseReadClient();

  const { data: v } = await db.from("vehicles")
    .select("id, registration_no, make, model, year, status, odometer")
    .eq("id", params.id).eq("company_id", p.companyId).maybeSingle();
  if (!v) notFound();

  const [{ data: docs }, { data: maint }, { data: fuel }, { data: trips }, { data: drivers }] = await Promise.all([
    db.from("vehicle_documents").select("id, doc_type, reference, expiry_date").eq("vehicle_id", v.id).eq("company_id", p.companyId),
    db.from("maintenance_records").select("id, kind, cost, service_date, next_service_date").eq("vehicle_id", v.id).eq("company_id", p.companyId).order("service_date", { ascending: false }),
    db.from("fuel_logs").select("id, litres, cost, odometer, logged_at").eq("vehicle_id", v.id).eq("company_id", p.companyId).order("odometer", { ascending: false }).limit(50),
    db.from("trips").select("id, purpose, start_odometer, end_odometer, started_at, drivers(name)").eq("vehicle_id", v.id).eq("company_id", p.companyId).order("started_at", { ascending: false }).limit(50),
    db.from("drivers").select("id, name").eq("company_id", p.companyId).eq("status", "active").order("name"),
  ]);

  const now = new Date();
  const eff = fuelEfficiency((fuel ?? []).map((f: any): FuelLog => ({ odometer: f.odometer, litres: f.litres })));
  const docBadge = (d: string | null) => { const s = renewalStatus(d, now, 30); return s === "expired" ? "danger" : s === "due_soon" ? "warn" : ""; };

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1 className="mono">{v.registration_no}</h1>
          <p className="muted mt-1">{[v.make, v.model, v.year].filter(Boolean).join(" ") || "—"} · <span className="badge">{v.status}</span></p>
        </div>
        <Link className="btn ghost sm" href="/app/fleet/vehicles">← Vehicles</Link>
      </div>

      <div className="card">
        <div className="card-title">Documents</div>
        <form action={addVehicleDocument} className="row gap-1 wrap mt-2">
          <input type="hidden" name="vehicle_id" value={v.id} />
          <select name="doc_type" className="select" style={{ width: 150 }} defaultValue="insurance">{DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <input name="reference" className="input" style={{ width: 150 }} placeholder="Reference" />
          <label className="small dim">Expiry <input name="expiry_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn ghost sm" type="submit">Add</button>
        </form>
        <div className="stack gap-1 mt-3">
          {(docs ?? []).length === 0 && <div className="empty">No documents.</div>}
          {(docs ?? []).map((d: any) => (
            <div key={d.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
              <span><span className="badge">{d.doc_type}</span> {d.reference ?? ""}</span>
              <span>{d.expiry_date ? <span className={`badge ${docBadge(d.expiry_date)}`}>{d.expiry_date}</span> : <span className="dim">no expiry</span>}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Fuel <span className="dim small">{eff.kmPerLitre != null ? `· ${eff.kmPerLitre} km/L` : ""}</span></div>
          <form action={addFuelLog} className="row gap-1 wrap mt-2">
            <input type="hidden" name="vehicle_id" value={v.id} />
            <input name="litres" className="input" style={{ width: 90 }} placeholder="Litres" inputMode="decimal" />
            <input name="cost" className="input" style={{ width: 100 }} placeholder="Cost" inputMode="decimal" />
            <input name="odometer" className="input" style={{ width: 110 }} placeholder="Odometer" inputMode="decimal" />
            <button className="btn ghost sm" type="submit">Log</button>
          </form>
          <div className="stack gap-1 mt-3">
            {(fuel ?? []).length === 0 && <div className="empty">No fuel logs.</div>}
            {(fuel ?? []).slice(0, 8).map((f: any) => (
              <div key={f.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                <span>{Number(f.litres ?? 0)} L @ {Number(f.odometer ?? 0)} km</span><span className="dim">{fmtMoney(f.cost)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Maintenance</div>
          <form action={addMaintenance} className="row gap-1 wrap mt-2">
            <input type="hidden" name="vehicle_id" value={v.id} />
            <input name="kind" className="input" style={{ width: 120 }} placeholder="Type" />
            <input name="cost" className="input" style={{ width: 90 }} placeholder="Cost" inputMode="decimal" />
            <label className="small dim">Next <input name="next_service_date" type="date" className="input" style={{ width: 140 }} /></label>
            <button className="btn ghost sm" type="submit">Add</button>
          </form>
          <div className="stack gap-1 mt-3">
            {(maint ?? []).length === 0 && <div className="empty">No maintenance records.</div>}
            {(maint ?? []).slice(0, 8).map((m: any) => (
              <div key={m.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                <span>{m.kind ?? "service"} {m.service_date ? `· ${m.service_date}` : ""}</span>
                <span>{m.next_service_date ? <span className={`badge ${docBadge(m.next_service_date)}`}>next {m.next_service_date}</span> : ""}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Trips</div>
        <form action={addTrip} className="row gap-1 wrap mt-2">
          <input type="hidden" name="vehicle_id" value={v.id} />
          <select name="driver_id" className="select" style={{ width: 150 }} defaultValue="">
            <option value="">No driver</option>
            {(drivers ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input name="purpose" className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Purpose" />
          <input name="start_odometer" className="input" style={{ width: 100 }} placeholder="Start km" inputMode="decimal" />
          <input name="end_odometer" className="input" style={{ width: 100 }} placeholder="End km" inputMode="decimal" />
          <button className="btn ghost sm" type="submit">Log trip</button>
        </form>
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Driver</th><th>Purpose</th><th className="num">Distance</th><th>When</th></tr></thead>
            <tbody>
              {(trips ?? []).length === 0 && <tr><td colSpan={4}><div className="empty">No trips.</div></td></tr>}
              {(trips ?? []).map((t: any) => (
                <tr key={t.id}>
                  <td>{t.drivers?.name ?? "—"}</td>
                  <td>{t.purpose ?? "—"}</td>
                  <td className="num">{t.end_odometer && t.start_odometer ? `${Number(t.end_odometer) - Number(t.start_odometer)} km` : "—"}</td>
                  <td className="dim small">{t.started_at ? new Date(t.started_at).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
