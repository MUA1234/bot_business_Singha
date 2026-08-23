/**
 * Fleet → Drivers (§9.4). Company-scoped create + list with licence-expiry flags.
 * Audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { createDriver } from "../vehicles/actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Drivers — Singha Central" };

interface DriverRow {
  id: string;
  name: string;
  licence_number: string | null;
  licence_expiry: string | null;
  phone: string | null;
  status: string;
}

export default async function DriversPage() {
  const p = await requireDepartment("fleet");
  const now = new Date();

  let rows: DriverRow[] = [];
  try {
    rows = ((await supabaseReadClient().from("drivers").select("id, name, licence_number, licence_expiry, phone, status").eq("company_id", p.companyId).order("name").limit(300)).data ?? []) as DriverRow[];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<DriverRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span>,
    },
    {
      key: "licence",
      header: "Licence",
      className: "mono dim small",
      render: (r) => r.licence_number ?? "—",
    },
    {
      key: "expiry",
      header: "Expiry",
      render: (r) => {
        const s = renewalStatus(r.licence_expiry ?? null, now, 30);
        const variant = s === "expired" ? "danger" : s === "due_soon" ? "warn" : "default";
        return r.licence_expiry ? <Badge variant={variant}>{fmtDate(r.licence_expiry)}</Badge> : <span className="dim small">—</span>;
      },
    },
    {
      key: "phone",
      header: "Phone",
      className: "dim small",
      render: (r) => r.phone ?? "—",
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Drivers</h1>
          <p className="muted mt-1">Driver roster and licence expiry.</p>
        </div>
        <Link className="btn ghost sm" href="/app/fleet">← Fleet</Link>
      </div>

      <Card>
        <CardHeader title="Add driver" />
        <CardBody>
          <form action={createDriver} className="row gap-1 wrap mt-2">
            <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Name" required />
            <input name="licence_number" className="input" style={{ width: 140 }} placeholder="Licence no" />
            <label className="small dim">Expiry <input name="licence_expiry" type="date" className="input" style={{ width: 150 }} /></label>
            <input name="phone" className="input" style={{ width: 140 }} placeholder="Phone" />
            <button className="btn" type="submit">Add</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Drivers (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No drivers yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
