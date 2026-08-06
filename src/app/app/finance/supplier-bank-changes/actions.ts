"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { canDecideBankChange } from "@/modules/finance/bank-change-guards";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

/** Maker: request a supplier bank-detail change. Records the request only — the
 *  supplier is NOT changed until a second person approves (§WP2.5). */
export async function requestBankChange(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const supplierId = String(formData.get("supplier_id") ?? "");
  const newName = String(formData.get("new_account_name") ?? "").trim();
  const newNumber = String(formData.get("new_account_number") ?? "").trim();
  if (!supplierId || (!newName && !newNumber)) return;

  const { data: supplier } = await db
    .from("suppliers")
    .select("id, bank_account_name, bank_account_number")
    .eq("id", supplierId)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!supplier) return; // cross-company / missing

  const { error } = await db.from("supplier_bank_detail_changes").insert({
    company_id: p.companyId,
    supplier_id: supplierId,
    old_account_name: supplier.bank_account_name,
    old_account_number: supplier.bank_account_number,
    new_account_name: newName || supplier.bank_account_name,
    new_account_number: newNumber || supplier.bank_account_number,
    requested_by: p.userId,
    status: "pending",
  });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "supplier_bank_change.requested", entityType: "supplier", entityId: supplierId });
  revalidatePath("/app/finance/supplier-bank-changes");
}

/** Checker: approve or reject a pending change. Approver must NOT be the requester;
 *  approval applies the new details to the supplier. Audited. */
export async function decideBankChange(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || (decision !== "approved" && decision !== "rejected")) return;

  const { data: change } = await db
    .from("supplier_bank_detail_changes")
    .select("id, supplier_id, new_account_name, new_account_number, requested_by, status")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!change) return;

  const guard = canDecideBankChange(change.status, change.requested_by, p.userId);
  if (!guard.ok) return; // not pending, or self-approval

  if (decision === "approved") {
    // Apply the new bank details to the supplier (company-scoped).
    await db
      .from("suppliers")
      .update({ bank_account_name: change.new_account_name, bank_account_number: change.new_account_number })
      .eq("id", change.supplier_id)
      .eq("company_id", p.companyId);
  }
  await db
    .from("supplier_bank_detail_changes")
    .update({ status: decision, approved_by: p.userId, decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `supplier_bank_change.${decision}`, entityType: "supplier", entityId: change.supplier_id });
  revalidatePath("/app/finance/supplier-bank-changes");
}
