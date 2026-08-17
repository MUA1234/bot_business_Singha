"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput } from "@/lib/money";

async function requireSales() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "sales") throw new Error("Not allowed");
  return p;
}

export async function createOpportunity(formData: FormData): Promise<void> {
  const p = await requireSales();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  // Decimal money — never a JS float. Malformed/negative amounts fail like other invalid input.
  const amountMoney = parseMoneyInput(formData.get("amount"), "LKR");
  if (!amountMoney || amountMoney.isNegative()) return;
  const amount = amountMoney.toString();
  const probability = Math.min(100, Math.max(0, Number(formData.get("probability") ?? 0) || 0));
  const expected_close = String(formData.get("expected_close") ?? "").trim() || null;
  const lead_id = String(formData.get("lead_id") ?? "").trim() || null;

  const { error } = await supabaseWriteClient().from("opportunities").insert({
    company_id: p.companyId, title, amount, probability, expected_close, lead_id, status: "open",
  });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "opportunity.created", entityType: "opportunity", entityId: title, payload: { amount, probability } });
  revalidatePath("/app/sales/opportunities");
}

export async function setOpportunityStatus(formData: FormData): Promise<void> {
  const p = await requireSales();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !["open", "won", "lost"].includes(status)) return;
  const { data: o } = await supabaseWriteClient().from("opportunities").select("id, lead_id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!o) return;
  await supabaseWriteClient().from("opportunities").update({ status }).eq("id", id).eq("company_id", p.companyId);
  // Reflect a won/lost deal on its source lead, if any.
  if (o.lead_id && (status === "won" || status === "lost")) {
    await supabaseWriteClient().from("leads").update({ stage: status }).eq("id", o.lead_id).eq("company_id", p.companyId);
  }
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `opportunity.${status}`, entityType: "opportunity", entityId: id });
  revalidatePath("/app/sales/opportunities");
}
