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

export const metadata = { title: "Service Providers — Singha Central" };

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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Service Providers</h1>
          <p className="muted mt-1">Consultants and service-provider registry with compliance and insurance status.</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement">← Procurement</Link>
      </div>

      <div className="card">
        <div className="card-title">New service provider</div>
        <form action={createServiceProvider} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Provider / consultant name" required />
          <button className="btn" type="submit">Add provider</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All providers ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No service providers yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Provider</th><th>Capabilities</th><th>Service areas</th><th>Compliance</th><th>Insurance</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const health = providerHealth({
                    status: r.status,
                    compliance_status: r.compliance_status,
                    insurance_status: r.insurance_status,
                    insurance_expiry: r.insurance_expiry,
                  });
                  const healthBadge = health === "verified" ? "ok" : health === "blocked" ? "danger" : "warn";
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        <span className={`badge ${healthBadge}`}>{health}</span>
                        {r.status !== "active" && <span className="badge ml-1">{r.status}</span>}
                      </td>
                      <td className="dim small">{(r.capabilities ?? []).length === 0 ? "—" : r.capabilities.join(", ")}</td>
                      <td className="dim small">{(r.service_areas ?? []).length === 0 ? "—" : r.service_areas.join(", ")}</td>
                      <td><span className="badge">{r.compliance_status}</span></td>
                      <td>
                        <span className="badge">{r.insurance_status}</span>
                        {r.insurance_expiry && <div className="dim small">expires {r.insurance_expiry}</div>}
                      </td>
                      <td><Link className="btn ghost sm" href={`/app/procurement/service-providers/${r.id}`}>Open</Link></td>
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
