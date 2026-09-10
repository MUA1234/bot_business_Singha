"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireLegal() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "legal") throw new Error("Not allowed");
  return p;
}

export async function createInsurance(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const policy_name = String(formData.get("policy_name") ?? "").trim();
  if (!policy_name) return;
  const insurer = String(formData.get("insurer") ?? "").trim() || null;
  const policy_number = String(formData.get("policy_number") ?? "").trim() || null;
  const cover_amount = String(formData.get("cover_amount") ?? "").trim() || null;
  const currency = String(formData.get("currency") ?? "LKR").trim() || "LKR";
  const expiry_date = String(formData.get("expiry_date") ?? "").trim() || null;

  const { data, error } = await supabaseWriteClient()
    .from("insurances")
    .insert({
      company_id: p.companyId,
      policy_name,
      insurer,
      policy_number,
      cover_amount: cover_amount ? Number(cover_amount) : null,
      currency,
      expiry_date,
      status: "active",
    })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "insurance.created",
    entityType: "insurance",
    entityId: data?.id ?? null,
    payload: { policy_name },
  });
  revalidatePath("/app/legal/insurances");
  revalidatePath("/app/legal");
}
