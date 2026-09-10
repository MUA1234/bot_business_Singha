/**
 * Procurement → Service providers (CRM-003).
 *
 * Company-scoped registry of consultants and service providers with capability,
 * service-area, compliance and insurance badges. Create form is audited.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { providerHealth } from "@/modules/crm/service-provider";
import { createServiceProvider } from "./actions";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Service Providers — Singha Central" };

type BadgeVariant = "default" | "ok" | "warn" | "danger" | "info" | "accent";

interface ProviderRow {
  id: string;
  name: string;
  status: string;
  capabilities: string[];
  service_areas: string[];
  compliance_status: string;
  insurance_status: string;
  insurance_expiry: string | null;
}

export default async function ServiceProvidersPage() {
  const p = await requireDepartment("procurement");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("service_providers")
      .select("id, name, status, capabilities, service_areas, compliance_status, insurance_status, insurance_expiry")
      .eq("company_id", p.companyId)
      .order("name", { ascending: true })
      .limit(500);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  const providers: ProviderRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    capabilities: r.capabilities ?? [],
    service_areas: r.service_areas ?? [],
    compliance_status: r.compliance_status ?? "pending",
    insurance_status: r.insurance_status ?? "pending",
    insurance_expiry: r.insurance_expiry ?? null,
  }));

  const columns: DataTableColumn<ProviderRow>[] = [
    {
      key: "name",
      header: "Provider",
      render: (r) => {
        const health = providerHealth({
          status: r.status,
          compliance_status: r.compliance_status,
          insurance_status: r.insurance_status,
          insurance_expiry: r.insurance_expiry,
        });
        const healthBadge: BadgeVariant = health === "verified" ? "ok" : health === "blocked" ? "danger" : "warn";
        return (
          <div>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <Badge variant={healthBadge}>{health}</Badge>
            {r.status !== "active" && <Badge className="ml-1">{r.status}</Badge>}
          </div>
        );
      },
    },
    {
      key: "capabilities",
      header: "Capabilities",
      className: "dim small",
      render: (r) => (r.capabilities.length === 0 ? "—" : r.capabilities.join(", ")),
    },
    {
      key: "serviceAreas",
      header: "Service areas",
      className: "dim small",
      render: (r) => (r.service_areas.length === 0 ? "—" : r.service_areas.join(", ")),
    },
    {
      key: "compliance",
      header: "Compliance",
      render: (r) => <Badge>{r.compliance_status}</Badge>,
    },
    {
      key: "insurance",
      header: "Insurance",
      render: (r) => (
        <>
          <Badge>{r.insurance_status}</Badge>
          {r.insurance_expiry && <div className="dim small">expires {fmtDate(r.insurance_expiry)}</div>}
        </>
      ),
    },
    {
      key: "open",
      header: "",
      render: (r) => <Link className="btn ghost sm" href={`/app/procurement/service-providers/${r.id}`}>Open</Link>,
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Service Providers</h1>
          <p className="muted mt-1">Consultants and service-provider registry with compliance and insurance status.</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement">← Procurement</Link>
      </div>

      <Card>
        <CardHeader title="New service provider" />
        <CardBody>
          <form action={createServiceProvider} className="row gap-1 wrap mt-2">
            <input name="name" className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Provider / consultant name" required />
            <button className="btn" type="submit">Add provider</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`All providers (${providers.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={providers}
            keyExtractor={(r) => r.id}
            emptyTitle="No service providers yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
