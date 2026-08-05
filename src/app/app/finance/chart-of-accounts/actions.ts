"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";

const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

export async function createAccount(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!code || !name || !TYPES.includes(type as any)) return;

  const { error } = await supabaseAdmin()
    .from("chart_of_accounts")
    .insert({ company_id: p.companyId, code, name, type, is_active: true });
  if (error) return; // duplicate code or table missing
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "account.created", entityType: "chart_of_accounts", entityId: code, payload: { name, type } });
  revalidatePath("/app/finance/chart-of-accounts");
}
