import Link from "next/link";
import { createVehicle } from "@/app/app/fleet/vehicles/actions";
import { Card, CardHeader, CardBody, Badge, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

type PlainObject = Record<string, unknown>;

export interface VehicleRow {
  id: string;
  registration_no: string;
  make: string | null;
  model: string | null;
  year: number | null;
  status: string;
  odometer: number | null;
}

interface VehiclesPanelData {
  rows: VehicleRow[];
}

export function VehiclesPanelContent({ data, embedded }: { data: PlainObject; embedded?: boolean }) {
  const { rows } = data as unknown as VehiclesPanelData;

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
      render: (r) => (r.year != null ? fmtNumber(r.year) : "—"),
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
      {!embedded && (
        <div className="row between">
          <div>
            <h1>Vehicles</h1>
            <p className="muted mt-1">Your fleet register.</p>
          </div>
          <Link className="btn ghost sm" href="/app/fleet">← Fleet</Link>
        </div>
      )}

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
