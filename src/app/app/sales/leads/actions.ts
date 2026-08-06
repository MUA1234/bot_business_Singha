"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireSales() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "sales") throw new Error("Not allowed");
  return p;
}

export async function createLead(formData: FormData): Promise<void> {
  const p = await requireSales();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const contact = String(formData.get("contact") ?? "").trim() || null;
  const source = String(formData.get("source") ?? "").trim() || null;
  const estimated_value = Number(formData.get("estimated_value") ?? 0) || 0;

  const { data, error } = await supabaseWriteClient()
    .from("leads")
    .insert({
      company_id: p.companyId,
      name,
      contact,
      source,
      stage: "new",
      estimated_value,
      last_contact_at: new Date().toISOString(),
      created_by: p.userId,
    })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "lead.created", entityType: "lead", entityId: data?.id ?? null, payload: { name } });
  revalidatePath("/app/sales/leads");
}

const STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;

export async function setLeadStage(formData: FormData): Promise<void> {
  const p = await requireSales();
  const id = String(formData.get("id") ?? "");
  const stage = String(formData.get("stage") ?? "");
  if (!id || !STAGES.includes(stage as any)) return;

  const { data: target } = await supabaseWriteClient()
    .from("leads").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!target) return;

  await supabaseWriteClient()
    .from("leads")
    .update({ stage, last_contact_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  revalidatePath("/app/sales/leads");
}
