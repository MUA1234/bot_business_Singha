"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput } from "@/lib/money";

async function requireFundingManager() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

/** Create a company-scoped funding requirement (FIN-007). */
export async function createFundingRequirement(formData: FormData): Promise<void> {
  const p = await requireFundingManager();
  const db = supabaseWriteClient();

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const amountRaw = String(formData.get("required_amount") ?? "").trim();
  const currency = String(formData.get("currency") ?? "LKR").trim().toUpperCase();
  const requiredBy = String(formData.get("required_by_date") ?? "").trim() || null;

  if (!name || !amountRaw || !/^[A-Z]{3}$/.test(currency)) return;

  const amount = parseMoneyInput(amountRaw, currency);
  if (!amount) return;

  const { data: req, error } = await db
    .from("funding_requirements")
    .insert({
      company_id: p.companyId,
      name,
      description,
      required_amount: amount.toRawString(),
      currency,
      required_by_date: requiredBy,
      status: "draft",
    })
    .select("id")
    .maybeSingle();
  if (error || !req) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "funding_requirement.created",
    entityType: "funding_requirement",
    entityId: req.id,
    payload: { name, required_amount: amount.toString(), currency, required_by_date: requiredBy },
  });
  revalidatePath("/app/finance/funding");
}

/** Update the status of a funding requirement. */
export async function updateFundingRequirementStatus(formData: FormData): Promise<void> {
  const p = await requireFundingManager();
  const db = supabaseWriteClient();

  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  const fundingSource = String(formData.get("funding_source") ?? "").trim() || null;

  if (!id || !["draft", "requested", "approved", "rejected", "funded"].includes(status)) return;

  const { data: existing } = await db
    .from("funding_requirements")
    .select("id")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!existing) return;

  const update: Record<string, unknown> = { status };
  if (fundingSource !== null) update.funding_source = fundingSource;

  const { error } = await db.from("funding_requirements").update(update).eq("id", id).eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "funding_requirement.status_updated",
    entityType: "funding_requirement",
    entityId: id,
    payload: { status, funding_source: fundingSource },
  });
  revalidatePath("/app/finance/funding");
}

/** Create a company-scoped investment register entry (FIN-007). */
export async function createInvestment(formData: FormData): Promise<void> {
  const p = await requireFundingManager();
  const db = supabaseWriteClient();

  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim() || null;
  const costRaw = String(formData.get("cost_basis") ?? "").trim();
  const currency = String(formData.get("currency") ?? "LKR").trim().toUpperCase();
  const acquisitionDate = String(formData.get("acquisition_date") ?? "").trim() || null;
  const location = String(formData.get("location") ?? "").trim() || null;

  if (!name || !costRaw || !/^[A-Z]{3}$/.test(currency)) return;

  const cost = parseMoneyInput(costRaw, currency);
  if (!cost) return;

  const { data: inv, error } = await db
    .from("investments")
    .insert({
      company_id: p.companyId,
      name,
      kind,
      cost_basis: cost.toRawString(),
      currency,
      acquisition_date: acquisitionDate,
      location,
      status: "active",
    })
    .select("id")
    .maybeSingle();
  if (error || !inv) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "investment.created",
    entityType: "investment",
    entityId: inv.id,
    payload: { name, kind, cost_basis: cost.toString(), currency, acquisition_date: acquisitionDate, location },
  });
  revalidatePath("/app/finance/funding");
}

/** Record disposal of an investment. */
export async function disposeInvestment(formData: FormData): Promise<void> {
  const p = await requireFundingManager();
  const db = supabaseWriteClient();

  const id = String(formData.get("id") ?? "").trim();
  const proceedsRaw = String(formData.get("disposal_proceeds") ?? "").trim();
  const disposalDate = String(formData.get("disposal_date") ?? "").trim() || null;

  if (!id || !proceedsRaw || !disposalDate) return;

  const { data: existing } = await db
    .from("investments")
    .select("id, currency")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!existing) return;

  const proceeds = parseMoneyInput(proceedsRaw, existing.currency as string);
  if (!proceeds) return;

  const { error } = await db
    .from("investments")
    .update({
      status: "disposed",
      disposal_date: disposalDate,
      disposal_proceeds: proceeds.toRawString(),
    })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "investment.disposed",
    entityType: "investment",
    entityId: id,
    payload: { disposal_date: disposalDate, disposal_proceeds: proceeds.toString() },
  });
  revalidatePath("/app/finance/funding");
}
