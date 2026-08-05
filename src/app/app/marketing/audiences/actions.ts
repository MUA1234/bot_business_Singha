"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";

async function requireMarketing() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "marketing") throw new Error("Not allowed");
  return p;
}

export async function createAudience(formData: FormData): Promise<void> {
  const p = await requireMarketing();
  const name = String(formData.get("name") ?? "").trim();
  const source = String(formData.get("source") ?? "customers");
  if (!name || !["customers", "leads", "manual"].includes(source)) return;
  const { error } = await supabaseAdmin().from("audiences").insert({ company_id: p.companyId, name, source });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "audience.created", entityType: "audience", entityId: name, payload: { source } });
  revalidatePath("/app/marketing/audiences");
}
