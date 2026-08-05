"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";

async function requireLegal() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "legal") throw new Error("Not allowed");
  return p;
}

export async function createMatter(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const matter_type = String(formData.get("matter_type") ?? "").trim() || null;
  const { error } = await supabaseAdmin().from("legal_matters").insert({ company_id: p.companyId, title, matter_type, status: "open", owner_id: p.userId });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "legal_matter.created", entityType: "legal_matter", entityId: title });
  revalidatePath("/app/legal/matters");
}

export async function setMatterStatus(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !["open", "on_hold", "closed"].includes(status)) return;
  const { data: m } = await supabaseAdmin().from("legal_matters").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!m) return;
  await supabaseAdmin().from("legal_matters").update({ status }).eq("id", id).eq("company_id", p.companyId);
  revalidatePath("/app/legal/matters");
}
