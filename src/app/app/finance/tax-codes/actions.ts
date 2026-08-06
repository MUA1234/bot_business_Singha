"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

export async function createTaxCode(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!code || !name) return;
  const rate = Math.max(0, Number(formData.get("rate") ?? 0) || 0);
  const { error } = await supabaseWriteClient().from("tax_codes").insert({ company_id: p.companyId, code, name, rate, is_active: true });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "tax_code.created", entityType: "tax_code", entityId: code, payload: { rate } });
  revalidatePath("/app/finance/tax-codes");
}
