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

export async function createLicence(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const authority = String(formData.get("authority") ?? "").trim() || null;
  const licence_number = String(formData.get("licence_number") ?? "").trim() || null;
  const issue_date = String(formData.get("issue_date") ?? "").trim() || null;
  const expiry_date = String(formData.get("expiry_date") ?? "").trim() || null;
  const { error } = await supabaseAdmin().from("licences").insert({ company_id: p.companyId, name, authority, licence_number, issue_date, expiry_date, status: "active" });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "licence.created", entityType: "licence", entityId: name });
  revalidatePath("/app/legal/licences");
  revalidatePath("/app/legal");
}
