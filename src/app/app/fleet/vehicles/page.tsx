/**
 * Fleet → Vehicles. Company-scoped create + list (audited). Graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createVehicle } from "./actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "Vehicles — Singha Central" };

interface VehicleRow {
  id: string;
  registration_no: string;
  make: string | null;
  model: string | null;
  year: number | null;
  status: string;
  odometer: number | null;
}

export default async function VehiclesPage() {
  const p = await requireDepartment("fleet");

  let rows: VehicleRow[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("vehicles")
      .select("id, registration_no, make, model, year, status, odometer")
      .eq("company_id", p.companyId)
      .order("registration_no")
      .limit(300);
    rows = (data ?? []) as VehicleRow[];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<VehicleRow>[] = [
    {
      key: "regNo",
      header: "Reg. no",
      render: (r) => <span className="mono" style={{ fontWeight: 600 }}>{r.registration_no}</span>,
    },
    {
      key: "vehicle",
      header: "Vehicle",
      render: (r) => [r.make, r.model].filter(Boolean).join(" ") || "—",
    },
    {
      key: "year",
      header: "Year",
      className: "dim small",
      render: (r) => r.year != null ? fmtNumber(r.year) : "—",
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge>{r.status}</Badge>,
    },
    {
      key: "open",
      header: "",
      render: (r) => <Link className="btn ghost sm" href={`/app/fleet/vehicles/${r.id}`}>Open</Link>,
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Vehicles</h1>
          <p className="muted mt-1">Your fleet register.</p>
        </div>
        <Link className="btn ghost sm" href="/app/fleet">← Fleet</Link>
      </div>

      <Card>
        <CardHeader title="Add vehicle" />
        <CardBody>
          <form action={createVehicle} className="row gap-1 wrap mt-2">
            <input name="registration_no" className="input" style={{ width: 150 }} placeholder="Reg. no" required />
            <input name="make" className="input" style={{ width: 130 }} placeholder="Make" />
            <input name="model" className="input" style={{ width: 130 }} placeholder="Model" />
            <input name="year" className="input" style={{ width: 90 }} placeholder="Year" inputMode="numeric" />
            <button className="btn" type="submit">Add</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Fleet (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No vehicles yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
