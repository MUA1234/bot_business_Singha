/**
 * Fleet & Transport overview (§9.4). Runs the pure renewal detector over vehicle
 * documents (insurance/registration/…), scheduled maintenance and driver licence
 * expiry, surfacing what's overdue or due soon. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { detectRenewals, type RenewalItem } from "@/management/ai-manager/renewals";

export const metadata = { title: "Fleet & Transport — Singha" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function FleetHome() {
  const p = await requireDepartment("fleet");
  const db = supabaseReadClient();
  const now = new Date();

  const [vehicles, docs, maint, drivers] = await Promise.all([
    safe<any>(() => db.from("vehicles").select("id, registration_no, status").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("vehicle_documents").select("id, doc_type, expiry_date, vehicle_id").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("maintenance_records").select("id, kind, next_service_date").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("drivers").select("id, name, licence_expiry").eq("company_id", p.companyId) as any),
  ]);

  const items: RenewalItem[] = [
    ...docs.map((d) => ({ id: `doc-${d.id}`, label: `${d.doc_type} document`, dueDate: d.expiry_date, kind: "document" })),
    ...maint.map((m) => ({ id: `mnt-${m.id}`, label: `Service due: ${m.kind ?? "maintenance"}`, dueDate: m.next_service_date, kind: "maintenance" })),
    ...drivers.map((dr) => ({ id: `drv-${dr.id}`, label: `Driver licence: ${dr.name}`, dueDate: dr.licence_expiry, kind: "driver" })),
  ];
  const alerts = detectRenewals(items, now, 30);
  const badge = (s: string) => (s === "critical" ? "danger" : s === "warn" ? "warn" : "info");

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Fleet &amp; Transport</h1>
          <p className="muted mt-1">Vehicle documents, maintenance and driver licences.</p>
        </div>
        <Link className="btn ghost sm" href="/app/fleet/vehicles">Vehicles →</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Vehicles</div><div className="v" style={{ fontSize: "1.5rem" }}>{vehicles.length}</div></div>
        <div className="card stat"><div className="k">Drivers</div><div className="v" style={{ fontSize: "1.5rem" }}>{drivers.length}</div></div>
        <div className="card stat"><div className="k">Alerts</div><div className="v" style={{ fontSize: "1.5rem", color: alerts.length ? "var(--danger)" : "var(--ok)" }}>{alerts.length}</div></div>
      </div>

      <div className="card">
        <div className="card-title">Expiring &amp; overdue</div>
        {alerts.length === 0 ? (
          <div className="empty">No fleet documents or services overdue in the next 30 days.</div>
        ) : (
          <div className="stack gap-1 mt-2">
            {alerts.map((a) => (
              <div key={a.id} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{a.label}</span>
                <span className={`badge ${badge(a.severity)}`}>{a.status === "expired" ? "expired" : `${a.daysUntil}d`}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
