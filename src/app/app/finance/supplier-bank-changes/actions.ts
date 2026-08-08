"use server";

import { revalidatePath } from "next/cache";
import { log, newCorrelationId } from "@/lib/log";
import { requireCapabilityStrict, type SessionProfile } from "@/lib/auth";
import { supabaseRpcClient } from "@/lib/supabase/read";

/** Maker: request a supplier bank-detail change (finance.bank_details.request). The
 *  supplier is NOT changed until a second person approves. Transactional RPC (0045);
 *  the request row is written only inside the RPC (no direct authenticated write). */
export async function requestBankChange(formData: FormData): Promise<void> {
  const supplierId = String(formData.get("supplier_id") ?? "");
  const newName = String(formData.get("new_account_name") ?? "").trim();
  const newNumber = String(formData.get("new_account_number") ?? "").trim();
  if (!supplierId || (!newName && !newNumber)) return;
  let p: SessionProfile;
  try { p = await requireCapabilityStrict("finance.bank_details.request"); } catch { return; }

  const { error } = await supabaseRpcClient().rpc("request_supplier_bank_change", {
    p_company: p.companyId, p_supplier: supplierId,
    p_new_name: newName, p_new_number: newNumber, p_by: p.userId,
  });
  if (error) { log("error", "finance action failed", { event: "finance.action_failed", correlationId: newCorrelationId(), companyId: p.companyId, error: error.message }); return; }
  revalidatePath("/app/finance/supplier-bank-changes");
}

/** Checker: approve/reject a pending change (finance.bank_details.approve). The RPC (0045)
 *  enforces pending lifecycle + maker≠checker and applies the supplier update + audit in
 *  one transaction. Sensitive bank numbers never enter logs. */
export async function decideBankChange(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || (decision !== "approved" && decision !== "rejected")) return;
  let p: SessionProfile;
  try { p = await requireCapabilityStrict("finance.bank_details.approve"); } catch { return; }

  const { error } = await supabaseRpcClient().rpc("decide_supplier_bank_change", {
    p_company: p.companyId, p_change: id, p_decision: decision, p_by: p.userId,
    p_note: String(formData.get("note") ?? "").trim() || null,
  });
  if (error) { log("error", "finance action failed", { event: "finance.action_failed", correlationId: newCorrelationId(), companyId: p.companyId, error: error.message }); return; }
  revalidatePath("/app/finance/supplier-bank-changes");
}
