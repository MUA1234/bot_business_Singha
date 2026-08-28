/**
 * Fleet & Transport overview (§9.4). Runs the pure renewal detector over vehicle
 * documents (insurance/registration/…), scheduled maintenance and driver licence
 * expiry, surfacing what's overdue or due soon. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { detectRenewals, type RenewalItem } from "@/management/ai-manager/renewals";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { fmtNumber } from "@/lib/format";
import {
  Constellation,
  Matter,
  PageHead,
  ProvenanceTag,
  Section,
  Signal,
  StateNote,
  type Cluster,
  type ConstellationNode,
} from "@/components/os/primitives";

export const metadata = { title: "Fleet & Transport — Singha Central" };

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
  const badgeVariant = (s: string) => (s === "critical" ? "danger" : s === "warn" ? "warn" : "info");

  // The fleet as a spatial field, grouped by the state each vehicle is
  // recorded in. A vehicle with no recorded status is shown as exactly that,
  // rather than being folded into "available".
  const byState = new Map<string, ConstellationNode[]>();
  for (const v of vehicles) {
    const state = (v.status ?? "not recorded").toString();
    const list = byState.get(state) ?? [];
    list.push({
      id: v.id,
      label: v.registration_no ?? "unregistered",
      band: state === "in_service" || state === "active" ? "normal" : state === "not recorded" ? "blocked" : "high",
      href: `/app/fleet/vehicles/${v.id}`,
      icon: "car",
    });
    byState.set(state, list);
  }
  const clusters: Cluster[] = [...byState.entries()].map(([state, nodes]) => ({
    key: state,
    name: state.replace(/_/g, " "),
    nodes,
  }));

  const expired = alerts.filter((a) => a.status === "expired");
  const dueSoon = alerts.filter((a) => a.status !== "expired");

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Assets"
        title="Fleet control tower"
        lede="Vehicles, drivers, documents and services. Compliance dates come from the records themselves — no location, telemetry or tracking data is read, inferred or displayed anywhere on this screen."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/fleet/vehicles">Vehicles</Link>
            <Link className="btn ghost sm" href="/app/fleet/drivers">Drivers</Link>
          </>
        }
      />

      {alerts.length > 0 && (
        <>
          <Section title="Needs a decision" meta="expired or due within 30 days" />
          <div className="field-matters">
            {expired.length > 0 && (
              <Matter
                kind="Expired"
                kindIcon="alert-triangle"
                band="critical"
                title={
                  expired.length === 1
                    ? "A document, service or licence has already expired"
                    : `${expired.length} documents, services or licences have already expired`
                }
                footer={<Signal kind="critical">Operating on an expired document is a legal exposure</Signal>}
              />
            )}
            {dueSoon.length > 0 && (
              <Matter
                kind="Due soon"
                kindIcon="clock"
                band="high"
                title={`${dueSoon.length} ${dueSoon.length === 1 ? "renewal falls" : "renewals fall"} due within 30 days`}
                footer={<Signal kind="warn">Renew before the date, not after</Signal>}
              />
            )}
          </div>
        </>
      )}

      <Section title="Position" />
      <div className="grid cols-3">
        <Link href="/app/fleet/vehicles" className="card stat">
          <div className="k">Vehicles</div>
          <div className="v">{fmtNumber(vehicles.length)}</div>
          <div className="d">Recorded in this company</div>
        </Link>
        <Link href="/app/fleet/drivers" className="card stat">
          <div className="k">Drivers</div>
          <div className="v">{fmtNumber(drivers.length)}</div>
          <div className="d">With a licence record</div>
        </Link>
        <div className="card stat">
          <div className="k">Compliance alerts</div>
          <div className="v">{fmtNumber(alerts.length)}</div>
          <div className="d">
            {alerts.length === 0 ? (
              <Signal kind="ok">Nothing expired or due in 30 days</Signal>
            ) : (
              <Signal kind="critical">{expired.length} already expired</Signal>
            )}
          </div>
        </div>
      </div>

      <Section title="The fleet" meta="grouped by recorded state" />
      {vehicles.length === 0 ? (
        <StateNote kind="empty" title="No vehicles recorded">
          Add a vehicle to see it here with its documents, services and compliance dates.
        </StateNote>
      ) : (
        <div className="card pad-lg">
          <Constellation clusters={clusters} />
        </div>
      )}

      <Section title="Expiring and overdue" meta="worst first" />
      <div className="card">
        {alerts.length === 0 ? (
          <StateNote kind="empty" title="No upcoming expiries">
            No fleet document, service or driver licence is expired or falls due within 30 days,
            across the {fmtNumber(docs.length + maint.length + drivers.length)} dated record(s) read.
          </StateNote>
        ) : (
          <div className="stack gap-1">
            {alerts.map((a) => (
              <div key={a.id} className="node-card">
                <span className="node-card-text">
                  <span className="node-card-title">{a.label}</span>
                  <span className="node-card-note">
                    {a.status === "expired" ? "Already expired" : `Due in ${a.daysUntil} day(s)`}
                  </span>
                </span>
                <Badge variant={badgeVariant(a.severity)}>
                  {a.status === "expired" ? "expired" : `${a.daysUntil}d`}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>

      <Section title="What this screen does not know" />
      <div className="card">
        <div className="row wrap gap-3" style={{ marginBottom: "var(--sp-3)" }}>
          <span className="row gap-2">
            <ProvenanceTag kind="measured" />
            <span className="small muted">Documents, services and licence dates — read from records</span>
          </span>
          <span className="row gap-2">
            <ProvenanceTag kind="missing" />
            <span className="small muted">Location, trips, odometer, fuel telemetry and utilisation</span>
          </span>
        </div>
        <StateNote kind="config" title="Location and telemetry are not enabled">
          Utilisation, idle time, cost per kilometre and location history need vehicle telemetry,
          which is gated behind a separate legal and privacy review and is not implemented. This
          screen therefore reports what the records hold and does not estimate the rest — an
          invented utilisation figure would be worse than none.
        </StateNote>
      </div>
    </div>
  );
}
