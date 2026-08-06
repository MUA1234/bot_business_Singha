"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireProc() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "procurement") throw new Error("Not allowed");
  return p;
}

async function rfqInCompany(id: string, companyId: string) {
  const { data } = await supabaseWriteClient().from("rfqs").select("id").eq("id", id).eq("company_id", companyId).maybeSingle();
  return data ?? null;
}

export async function createRfq(formData: FormData): Promise<void> {
  const p = await requireProc();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const description = String(formData.get("description") ?? "").trim() || null;
  const { data, error } = await supabaseWriteClient().from("rfqs").insert({ company_id: p.companyId, title, description, status: "open", created_by: p.userId }).select("id").maybeSingle();
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "rfq.created", entityType: "rfq", entityId: data?.id ?? null, payload: { title } });
  revalidatePath("/app/procurement/rfqs");
}

export async function addQuotation(formData: FormData): Promise<void> {
  const p = await requireProc();
  const rfqId = String(formData.get("rfq_id") ?? "");
  if (!(await rfqInCompany(rfqId, p.companyId))) return;
  const supplier_name = String(formData.get("supplier_name") ?? "").trim();
  if (!supplier_name) return;
  const total_amount = Math.max(0, Number(formData.get("total_amount") ?? 0) || 0);
  const lead_time_days = String(formData.get("lead_time_days") ?? "").trim() === "" ? null : Math.max(0, Number(formData.get("lead_time_days")) || 0);
  const notes = String(formData.get("notes") ?? "").trim() || null;

  // Reuse/create the supplier by name.
  let supplierId: string | null = null;
  const { data: existing } = await supabaseWriteClient().from("suppliers").select("id").eq("company_id", p.companyId).eq("name", supplier_name).maybeSingle();
  if (existing) supplierId = existing.id;
  else {
    const { data: s } = await supabaseWriteClient().from("suppliers").insert({ company_id: p.companyId, name: supplier_name, status: "active" }).select("id").maybeSingle();
    supplierId = s?.id ?? null;
  }

  await supabaseWriteClient().from("supplier_quotations").insert({ company_id: p.companyId, rfq_id: rfqId, supplier_id: supplierId, supplier_name, total_amount, lead_time_days, notes });
  revalidatePath(`/app/procurement/rfqs/${rfqId}`);
}

export async function awardQuotation(formData: FormData): Promise<void> {
  const p = await requireProc();
  const rfqId = String(formData.get("rfq_id") ?? "");
  const quotationId = String(formData.get("quotation_id") ?? "");
  if (!(await rfqInCompany(rfqId, p.companyId)) || !quotationId) return;

  // Clear any prior selection, select this one, mark the RFQ awarded.
  await supabaseWriteClient().from("supplier_quotations").update({ is_selected: false }).eq("rfq_id", rfqId).eq("company_id", p.companyId);
  const { data: q } = await supabaseWriteClient().from("supplier_quotations").select("id").eq("id", quotationId).eq("rfq_id", rfqId).eq("company_id", p.companyId).maybeSingle();
  if (!q) return;
  await supabaseWriteClient().from("supplier_quotations").update({ is_selected: true }).eq("id", quotationId).eq("company_id", p.companyId);
  await supabaseWriteClient().from("rfqs").update({ status: "awarded" }).eq("id", rfqId).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "rfq.awarded", entityType: "rfq", entityId: rfqId, payload: { quotationId } });
  revalidatePath(`/app/procurement/rfqs/${rfqId}`);
  revalidatePath("/app/procurement/rfqs");
}
