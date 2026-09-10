"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireProcurement() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "procurement") throw new Error("Not allowed");
  return p;
}

const VALID_STATUSES = new Set(["active", "inactive", "blacklisted"]);
const VALID_COMPLIANCE_STATUSES = new Set(["pending", "verified", "expired"]);
const VALID_INSURANCE_STATUSES = new Set(["pending", "valid", "expired"]);

export async function createServiceProvider(formData: FormData): Promise<void> {
  const p = await requireProcurement();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const { data, error } = await supabaseWriteClient()
    .from("service_providers")
    .insert({ company_id: p.companyId, name, status: "active" })
    .select("id")
    .maybeSingle();
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "service_provider.created",
    entityType: "service_provider",
    entityId: data?.id ?? null,
    payload: { name },
  });
  revalidatePath("/app/procurement/service-providers");
  revalidatePath("/app/procurement");
}

/** Confirm a service provider belongs to the caller's company. */
async function providerInCompany(id: string, companyId: string) {
  const { data } = await supabaseWriteClient()
    .from("service_providers")
    .select("id")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();
  return data ?? null;
}

function cleanArray(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

export async function updateServiceProviderStatus(formData: FormData): Promise<void> {
  const p = await requireProcurement();
  const id = String(formData.get("id") ?? "");
  if (!id || !(await providerInCompany(id, p.companyId))) return;

  const status = String(formData.get("status") ?? "").trim();
  if (!VALID_STATUSES.has(status)) return;

  const complianceStatus = String(formData.get("compliance_status") ?? "").trim();
  if (!VALID_COMPLIANCE_STATUSES.has(complianceStatus)) return;

  const insuranceStatus = String(formData.get("insurance_status") ?? "").trim();
  if (!VALID_INSURANCE_STATUSES.has(insuranceStatus)) return;

  const insuranceExpiry = parseDate(String(formData.get("insurance_expiry") ?? ""));
  const capacityNotes = String(formData.get("capacity_notes") ?? "").trim() || null;
  const priceNotes = String(formData.get("price_notes") ?? "").trim() || null;
  const capabilities = cleanArray(String(formData.get("capabilities") ?? ""));
  const serviceAreas = cleanArray(String(formData.get("service_areas") ?? ""));

  const { error } = await supabaseWriteClient()
    .from("service_providers")
    .update({
      status,
      compliance_status: complianceStatus,
      insurance_status: insuranceStatus,
      insurance_expiry: insuranceExpiry,
      capacity_notes: capacityNotes,
      price_notes: priceNotes,
      capabilities,
      service_areas: serviceAreas,
    })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "service_provider.status_updated",
    entityType: "service_provider",
    entityId: id,
    payload: { status, compliance_status: complianceStatus, insurance_status: insuranceStatus },
  });
  revalidatePath(`/app/procurement/service-providers/${id}`);
  revalidatePath("/app/procurement/service-providers");
  revalidatePath("/app/procurement");
}
