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
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata = { title: "Vehicle — Singha Central" };
const DOC_TYPES = ["insurance", "registration", "emission", "permit", "other"];

interface TripRow {
  id: string;
  driverName: string | null;
  purpose: string | null;
  distance: number | null;
  started_at: string | null;
}

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
  const docBadgeVariant = (d: string | null) => { const s = renewalStatus(d, now, 30); return s === "expired" ? "danger" : s === "due_soon" ? "warn" : "default"; };

  const tripRows: TripRow[] = (trips ?? []).map((t: any) => ({
    id: t.id,
    driverName: t.drivers?.name ?? null,
    purpose: t.purpose ?? null,
    distance: t.end_odometer && t.start_odometer ? Number(t.end_odometer) - Number(t.start_odometer) : null,
    started_at: t.started_at ?? null,
  }));

  const tripColumns: DataTableColumn<TripRow>[] = [
    { key: "driver", header: "Driver", render: (t) => t.driverName ?? "—" },
    { key: "purpose", header: "Purpose", render: (t) => t.purpose ?? "—" },
    {
      key: "distance",
      header: "Distance",
      align: "right",
      render: (t) => t.distance != null ? `${fmtNumber(t.distance)} km` : "—",
    },
    {
      key: "when",
      header: "When",
      className: "dim small",
      render: (t) => fmtDate(t.started_at),
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1 className="mono">{v.registration_no}</h1>
          <p className="muted mt-1">{[v.make, v.model, v.year].filter(Boolean).join(" ") || "—"} · <Badge>{v.status}</Badge></p>
        </div>
        <Link className="btn ghost sm" href="/app/fleet/vehicles">← Vehicles</Link>
      </div>

      <Card>
        <CardHeader title="Documents" />
        <CardBody>
          <form action={addVehicleDocument} className="row gap-1 wrap mt-2">
            <input type="hidden" name="vehicle_id" value={v.id} />
            <select name="doc_type" className="select" style={{ width: 150 }} defaultValue="insurance">{DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            <input name="reference" className="input" style={{ width: 150 }} placeholder="Reference" />
            <label className="small dim">Expiry <input name="expiry_date" type="date" className="input" style={{ width: 150 }} /></label>
            <button className="btn ghost sm" type="submit">Add</button>
          </form>
          <div className="stack gap-1 mt-3">
            {(docs ?? []).length === 0 && <EmptyState title="No documents" icon="file-text" />}
            {(docs ?? []).map((d: any) => (
              <div key={d.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                <span><Badge>{d.doc_type}</Badge> {d.reference ?? ""}</span>
                <span>{d.expiry_date ? <Badge variant={docBadgeVariant(d.expiry_date)}>{fmtDate(d.expiry_date)}</Badge> : <span className="dim">no expiry</span>}</span>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "var(--space-3)" }}>
        <Card>
          <CardHeader title={<>Fuel <span className="dim small">{eff.kmPerLitre != null ? `· ${eff.kmPerLitre} km/L` : ""}</span></>} />
          <CardBody>
            <form action={addFuelLog} className="row gap-1 wrap mt-2">
              <input type="hidden" name="vehicle_id" value={v.id} />
              <input name="litres" className="input" style={{ width: 90 }} placeholder="Litres" inputMode="decimal" />
              <input name="cost" className="input" style={{ width: 100 }} placeholder="Cost" inputMode="decimal" />
              <input name="odometer" className="input" style={{ width: 110 }} placeholder="Odometer" inputMode="decimal" />
              <button className="btn ghost sm" type="submit">Log</button>
            </form>
            <div className="stack gap-1 mt-3">
              {(fuel ?? []).length === 0 && <EmptyState title="No fuel logs" icon="fuel" />}
              {(fuel ?? []).slice(0, 8).map((f: any) => (
                <div key={f.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                  <span>{fmtNumber(f.litres ?? 0)} L @ {fmtNumber(f.odometer ?? 0)} km</span><span className="dim">{fmtMoney(f.cost)}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Maintenance" />
          <CardBody>
            <form action={addMaintenance} className="row gap-1 wrap mt-2">
              <input type="hidden" name="vehicle_id" value={v.id} />
              <input name="kind" className="input" style={{ width: 120 }} placeholder="Type" />
              <input name="cost" className="input" style={{ width: 90 }} placeholder="Cost" inputMode="decimal" />
              <label className="small dim">Next <input name="next_service_date" type="date" className="input" style={{ width: 140 }} /></label>
              <button className="btn ghost sm" type="submit">Add</button>
            </form>
            <div className="stack gap-1 mt-3">
              {(maint ?? []).length === 0 && <EmptyState title="No maintenance records" icon="wrench" />}
              {(maint ?? []).slice(0, 8).map((m: any) => (
                <div key={m.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                  <span>{m.kind ?? "service"} {m.service_date ? `· ${fmtDate(m.service_date)}` : ""}</span>
                  <span>{m.next_service_date ? <Badge variant={docBadgeVariant(m.next_service_date)}>next {fmtDate(m.next_service_date)}</Badge> : null}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Trips" />
        <CardBody>
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
          <DataTable
            columns={tripColumns}
            rows={tripRows}
            keyExtractor={(t) => t.id}
            emptyTitle="No trips"
            className="mt-3"
          />
        </CardBody>
      </Card>
    </div>
  );
}
