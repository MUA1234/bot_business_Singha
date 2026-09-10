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

export async function createRisk(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const description = String(formData.get("description") ?? "").trim() || null;
  const owner_id = String(formData.get("owner_id") ?? "").trim() || null;
  const mitigation = String(formData.get("mitigation") ?? "").trim() || null;
  const evidence = String(formData.get("evidence") ?? "").trim() || null;
  const review_date = String(formData.get("review_date") ?? "").trim() || null;

  const { data, error } = await supabaseWriteClient()
    .from("risks")
    .insert({
      company_id: p.companyId,
      title,
      description,
      owner_id: owner_id || null,
      mitigation,
      evidence,
      review_date,
      status: "open",
    })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "risk.created",
    entityType: "risk",
    entityId: data?.id ?? null,
    payload: { title },
  });
  revalidatePath("/app/legal/risks");
  revalidatePath("/app/legal");
}
