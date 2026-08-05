"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

export async function createCommitment(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  const amount = Math.max(0, Number(formData.get("amount") ?? 0) || 0);
  const expected_settlement_date = String(formData.get("expected_settlement_date") ?? "").trim() || null;
  const counterparty = String(formData.get("counterparty") ?? "").trim() || null;
  const { error } = await supabaseAdmin().from("commitments").insert({ company_id: p.companyId, description, counterparty, currency: "LKR", amount, expected_settlement_date, status: "open" });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "commitment.created", entityType: "commitment", entityId: description, payload: { amount } });
  revalidatePath("/app/finance/commitments");
}

export async function settleCommitment(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const { data: c } = await supabaseAdmin().from("commitments").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!c) return;
  await supabaseAdmin().from("commitments").update({ status: "settled" }).eq("id", id).eq("company_id", p.companyId);
  revalidatePath("/app/finance/commitments");
}

export async function createRecurring(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const description = String(formData.get("description") ?? "").trim();
  const cadence = String(formData.get("cadence") ?? "monthly");
  if (!description || !["weekly", "monthly", "quarterly", "annual"].includes(cadence)) return;
  const amount = Math.max(0, Number(formData.get("amount") ?? 0) || 0);
  const next_due = String(formData.get("next_due") ?? "").trim() || null;
  const { error } = await supabaseAdmin().from("recurring_obligations").insert({ company_id: p.companyId, description, currency: "LKR", amount, cadence, next_due });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "recurring_obligation.created", entityType: "recurring_obligation", entityId: description, payload: { cadence, amount } });
  revalidatePath("/app/finance/commitments");
}
