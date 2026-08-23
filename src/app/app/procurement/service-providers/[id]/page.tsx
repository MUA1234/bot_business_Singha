/**
 * Service provider detail (CRM-003).
 *
 * Shows provider fields and an audited status update form. Company-scoped; graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { providerHealth } from "@/modules/crm/service-provider";
import { updateServiceProviderStatus } from "../actions";

export const metadata = { title: "Service Provider — Singha Central" };

export default async function ServiceProviderDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("procurement");
  const db = supabaseReadClient();

  const { data: provider } = await db
    .from("service_providers")
    .select("id, name, status, capabilities, service_areas, capacity_notes, price_notes, compliance_status, insurance_status, insurance_expiry, created_at, updated_at")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!provider) notFound();

  const health = providerHealth({
    status: provider.status,
    compliance_status: provider.compliance_status,
    insurance_status: provider.insurance_status,
    insurance_expiry: provider.insurance_expiry,
  });
  const healthBadge = health === "verified" ? "ok" : health === "blocked" ? "danger" : "warn";

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{provider.name}</h1>
          <p className="muted mt-1">
            <span className={`badge ${healthBadge}`}>{health}</span>
            <span className="badge ml-1">{provider.status}</span>
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement/service-providers">← All providers</Link>
      </div>

      <div className="card">
        <div className="card-title">Provider details</div>
        <div className="stack gap-1 mt-2">
          <div><strong>Capabilities:</strong> {(provider.capabilities ?? []).length === 0 ? "—" : provider.capabilities.join(", ")}</div>
          <div><strong>Service areas:</strong> {(provider.service_areas ?? []).length === 0 ? "—" : provider.service_areas.join(", ")}</div>
          {provider.capacity_notes && <div><strong>Capacity notes:</strong> {provider.capacity_notes}</div>}
          {provider.price_notes && <div><strong>Price notes:</strong> {provider.price_notes}</div>}
          <div><strong>Compliance:</strong> <span className="badge">{provider.compliance_status}</span></div>
          <div><strong>Insurance:</strong> <span className="badge">{provider.insurance_status}</span> {provider.insurance_expiry && <span className="dim small">expires {provider.insurance_expiry}</span>}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Update status</div>
        <form action={updateServiceProviderStatus} className="stack gap-2 mt-2">
          <input type="hidden" name="id" value={provider.id} />
          <div className="row gap-1 wrap">
            <label className="small">Status
              <select name="status" className="select" defaultValue={provider.status}>
                <option value="active">active</option>
                <option value="inactive">inactive</option>
                <option value="blacklisted">blacklisted</option>
              </select>
            </label>
            <label className="small">Compliance
              <select name="compliance_status" className="select" defaultValue={provider.compliance_status}>
                <option value="pending">pending</option>
                <option value="verified">verified</option>
                <option value="expired">expired</option>
              </select>
            </label>
            <label className="small">Insurance
              <select name="insurance_status" className="select" defaultValue={provider.insurance_status}>
                <option value="pending">pending</option>
                <option value="valid">valid</option>
                <option value="expired">expired</option>
              </select>
            </label>
            <label className="small">Insurance expiry
              <input type="date" name="insurance_expiry" className="input" defaultValue={provider.insurance_expiry ?? ""} />
            </label>
          </div>
          <div className="row gap-1 wrap">
            <input name="capabilities" className="input" style={{ flex: 1, minWidth: 200 }} defaultValue={(provider.capabilities ?? []).join(", ")} placeholder="Capabilities, comma-separated" />
            <input name="service_areas" className="input" style={{ flex: 1, minWidth: 200 }} defaultValue={(provider.service_areas ?? []).join(", ")} placeholder="Service areas, comma-separated" />
          </div>
          <textarea name="capacity_notes" className="textarea" defaultValue={provider.capacity_notes ?? ""} placeholder="Capacity notes" />
          <textarea name="price_notes" className="textarea" defaultValue={provider.price_notes ?? ""} placeholder="Price notes" />
          <button className="btn" type="submit">Save changes</button>
        </form>
      </div>
    </div>
  );
}
