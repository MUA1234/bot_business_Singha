"use server";

import { revalidatePath } from "next/cache";
import { log, newCorrelationId } from "@/lib/log";
import { requireProfile, requireCapabilityStrict } from "@/lib/auth";
import { supabaseWriteClient, supabaseRpcClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify";
import { parseMoneyInput } from "@/lib/money";
import { isSelfAction } from "@/modules/finance/expense-guards";

// §WP2 STRICT: deciding/reimbursing an expense requires finance.payment.record — no
// department fallback (these are payment decisions). The DB RPC re-checks the capability.
const requireFinance = () => requireCapabilityStrict("finance.payment.record");

/** Find-or-create the legacy employees row for a profile (interim identity bridge). */
async function ensureEmployee(profileId: string, companyId: string, name: string): Promise<string | null> {
  const db = supabaseWriteClient();
  const { data } = await db.from("employees").select("id").eq("company_id", companyId).eq("user_id", profileId).maybeSingle();
  if (data) return data.id;
  const { data: created } = await db.from("employees").insert({ company_id: companyId, user_id: profileId, name, status: "active" }).select("id").maybeSingle();
  return created?.id ?? null;
}

/** Any employee submits an expense claim for themselves. */
export async function submitExpense(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const amountMoney = parseMoneyInput(formData.get("amount"), "LKR");
  const purpose = String(formData.get("purpose") ?? "").trim();
  if (!amountMoney || !amountMoney.isPositive() || !purpose) return;
  const amount = amountMoney.toString(); // decimal string, never a JS float

  const employeeId = await ensureEmployee(p.userId, p.companyId, p.fullName ?? p.username);
  if (!employeeId) return;
  await supabaseWriteClient().from("expense_claims").insert({ company_id: p.companyId, employee_id: employeeId, currency: "LKR", amount, purpose, status: "submitted" });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "expense_claim.submitted", entityType: "expense_claim", entityId: employeeId, payload: { amount } });
  revalidatePath("/app/me");
  revalidatePath("/app/finance/expenses");
}

/** The profile (user) behind an employees row, if any. */
async function claimantUserId(companyId: string, employeeId: string): Promise<string | null> {
  const { data: emp } = await supabaseWriteClient().from("employees").select("user_id").eq("id", employeeId).eq("company_id", companyId).maybeSingle();
  return emp?.user_id ?? null;
}

/** Notify the profile behind an employees row, if any. */
async function notifyEmployee(companyId: string, employeeId: string, title: string) {
  const uid = await claimantUserId(companyId, employeeId);
  if (uid) await createNotification({ companyId, recipientId: uid, type: "expense_decided", title, link: "/app/me" });
}

export async function decideExpense(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || (decision !== "approved" && decision !== "rejected")) return;
  const { data: claim } = await supabaseWriteClient().from("expense_claims").select("id, employee_id, status").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!claim || claim.status !== "submitted") return;
  // §WP2.5 separation of duties — a user may not approve/reject their own claim.
  if (isSelfAction(await claimantUserId(p.companyId, claim.employee_id), p.userId)) return;
  await supabaseWriteClient().from("expense_claims").update({ status: decision }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `expense_claim.${decision}`, entityType: "expense_claim", entityId: id });
  await notifyEmployee(p.companyId, claim.employee_id, `Your expense claim was ${decision}`);
  revalidatePath("/app/finance/expenses");
}

/** Reimburse an approved claim: post Dr Expense / Cr Cash and record the reimbursement.
 *  Recording only — not a bank transfer. */
export async function reimburseExpense(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const id = String(formData.get("id") ?? "");
  const expenseCode = String(formData.get("expense_code") ?? "").trim();
  const cashCode = String(formData.get("cash_code") ?? "").trim();
  if (!id || !expenseCode || !cashCode) return;

  // §WP-B: the whole reimbursement is ONE transaction inside the RPC — capability check,
  // approved-status lifecycle, separation-of-duties (can't reimburse your own claim),
  // journal + payment + reimbursement row + claim status + audit, all atomic and idempotent.
  const { data: claim } = await db.from("expense_claims").select("employee_id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  // §WP2: authenticated RPC client so the DB enforces finance.payment.record + SoD + records the actor.
  const { error } = await supabaseRpcClient().rpc("reimburse_expense_claim", {
    p_company: p.companyId, p_claim: id,
    p_expense_code: expenseCode, p_cash_code: cashCode,
    p_by: p.userId, p_date: new Date().toISOString().slice(0, 10),
    p_idempotency_key: `reimburse:${id}`,
  });
  if (error) { log("error", "finance action failed", { event: "finance.action_failed", correlationId: newCorrelationId(), companyId: p.companyId, error: error.message }); return; }
  if (claim?.employee_id) await notifyEmployee(p.companyId, claim.employee_id, "Your expense was reimbursed");
  revalidatePath("/app/finance/expenses");
}
