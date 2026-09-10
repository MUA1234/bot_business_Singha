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
import { Card, CardHeader, CardBody, Badge, FormField } from "@/components/ui";
import { fmtDate } from "@/lib/format";

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
            <Badge variant={healthBadge}>{health}</Badge>
            <Badge className="ml-1">{provider.status}</Badge>
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement/service-providers">← All providers</Link>
      </div>

      <Card>
        <CardHeader title="Provider details" />
        <CardBody>
          <div className="stack gap-1 mt-2">
            <div><strong>Capabilities:</strong> {(provider.capabilities ?? []).length === 0 ? "—" : provider.capabilities.join(", ")}</div>
            <div><strong>Service areas:</strong> {(provider.service_areas ?? []).length === 0 ? "—" : provider.service_areas.join(", ")}</div>
            {provider.capacity_notes && <div><strong>Capacity notes:</strong> {provider.capacity_notes}</div>}
            {provider.price_notes && <div><strong>Price notes:</strong> {provider.price_notes}</div>}
            <div><strong>Compliance:</strong> <Badge>{provider.compliance_status}</Badge></div>
            <div><strong>Insurance:</strong> <Badge>{provider.insurance_status}</Badge> {provider.insurance_expiry && <span className="dim small">expires {fmtDate(provider.insurance_expiry)}</span>}</div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Update status" />
        <CardBody>
          <form action={updateServiceProviderStatus} className="stack gap-2 mt-2">
            <input type="hidden" name="id" value={provider.id} />
            <div className="row gap-1 wrap" style={{ alignItems: "flex-end" }}>
              <FormField name="status" label="Status" className="field">
                <select name="status" className="select" defaultValue={provider.status}>
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                  <option value="blacklisted">blacklisted</option>
                </select>
              </FormField>
              <FormField name="compliance_status" label="Compliance" className="field">
                <select name="compliance_status" className="select" defaultValue={provider.compliance_status}>
                  <option value="pending">pending</option>
                  <option value="verified">verified</option>
                  <option value="expired">expired</option>
                </select>
              </FormField>
              <FormField name="insurance_status" label="Insurance" className="field">
                <select name="insurance_status" className="select" defaultValue={provider.insurance_status}>
                  <option value="pending">pending</option>
                  <option value="valid">valid</option>
                  <option value="expired">expired</option>
                </select>
              </FormField>
              <FormField name="insurance_expiry" label="Insurance expiry" className="field">
                <input type="date" name="insurance_expiry" className="input" defaultValue={provider.insurance_expiry ?? ""} />
              </FormField>
            </div>
            <div className="row gap-1 wrap">
              <input name="capabilities" className="input" style={{ flex: 1, minWidth: 200 }} defaultValue={(provider.capabilities ?? []).join(", ")} placeholder="Capabilities, comma-separated" />
              <input name="service_areas" className="input" style={{ flex: 1, minWidth: 200 }} defaultValue={(provider.service_areas ?? []).join(", ")} placeholder="Service areas, comma-separated" />
            </div>
            <textarea name="capacity_notes" className="textarea" defaultValue={provider.capacity_notes ?? ""} placeholder="Capacity notes" />
            <textarea name="price_notes" className="textarea" defaultValue={provider.price_notes ?? ""} placeholder="Price notes" />
            <button className="btn" type="submit">Save changes</button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
