"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify";
import { billPostingLines } from "@/accounting/posting-templates";
import { checkDraftJournal } from "@/accounting/manual-entry";
import { parseMoneyInput } from "@/lib/money";
import { isSelfAction } from "@/modules/finance/expense-guards";
import { resolveIdempotencyKey } from "@/lib/idempotency";
import { claimIdempotencyKey } from "@/lib/idempotency-store";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

/** Find-or-create the legacy employees row for a profile (interim identity bridge). */
async function ensureEmployee(profileId: string, companyId: string, name: string): Promise<string | null> {
  const db = supabaseAdmin();
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
  await supabaseAdmin().from("expense_claims").insert({ company_id: p.companyId, employee_id: employeeId, currency: "LKR", amount, purpose, status: "submitted" });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "expense_claim.submitted", entityType: "expense_claim", entityId: employeeId, payload: { amount } });
  revalidatePath("/app/me");
  revalidatePath("/app/finance/expenses");
}

/** The profile (user) behind an employees row, if any. */
async function claimantUserId(companyId: string, employeeId: string): Promise<string | null> {
  const { data: emp } = await supabaseAdmin().from("employees").select("user_id").eq("id", employeeId).eq("company_id", companyId).maybeSingle();
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
  const { data: claim } = await supabaseAdmin().from("expense_claims").select("id, employee_id, status").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!claim || claim.status !== "submitted") return;
  // §WP2.5 separation of duties — a user may not approve/reject their own claim.
  if (isSelfAction(await claimantUserId(p.companyId, claim.employee_id), p.userId)) return;
  await supabaseAdmin().from("expense_claims").update({ status: decision }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `expense_claim.${decision}`, entityType: "expense_claim", entityId: id });
  await notifyEmployee(p.companyId, claim.employee_id, `Your expense claim was ${decision}`);
  revalidatePath("/app/finance/expenses");
}

/** Reimburse an approved claim: post Dr Expense / Cr Cash and record the reimbursement.
 *  Recording only — not a bank transfer. */
export async function reimburseExpense(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const id = String(formData.get("id") ?? "");
  const expenseCode = String(formData.get("expense_code") ?? "").trim();
  const cashCode = String(formData.get("cash_code") ?? "").trim();
  if (!id || !expenseCode || !cashCode) return;

  const { data: claim } = await db.from("expense_claims").select("id, employee_id, currency, amount, status").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!claim || claim.status !== "approved") return;
  // §WP2.5 — do not reimburse your own claim.
  if (isSelfAction(await claimantUserId(p.companyId, claim.employee_id), p.userId)) return;
  // Prevent a duplicate reimbursement (already-recorded, or a retry of this action).
  const { data: existing } = await db.from("reimbursements").select("id").eq("company_id", p.companyId).eq("expense_claim_id", id).maybeSingle();
  if (existing) return;
  const idemKey = resolveIdempotencyKey(String(formData.get("idem_token") ?? ""), ["reimburse_expense", id]);
  if ((await claimIdempotencyKey(p.companyId, "reimburse_expense", idemKey, p.userId)) === "duplicate") return;

  const lines = billPostingLines(expenseCode, cashCode, String(claim.amount ?? 0), "Expense reimbursement");
  if (!checkDraftJournal(lines, claim.currency).ready) return;
  const { data: journalId, error } = await db.rpc("post_manual_journal", {
    p_company: p.companyId, p_date: new Date().toISOString().slice(0, 10), p_currency: claim.currency,
    p_memo: "Expense reimbursement", p_posted_by: p.userId,
    p_lines: lines.map((l) => ({ account_code: l.account_code, debit: String(l.debit || "0"), credit: String(l.credit || "0"), description: l.description })),
    p_idempotency_key: `reimburse_post:${id}`, // §WP2 — a retry re-uses the same journal
  });
  if (error) return;

  await db.from("reimbursements").insert({ company_id: p.companyId, expense_claim_id: id, employee_id: claim.employee_id, currency: claim.currency, amount: claim.amount, status: "paid" });
  await db.from("expense_claims").update({ status: "reimbursed" }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "expense_claim.reimbursed", entityType: "expense_claim", entityId: id, payload: { journalId } });
  await notifyEmployee(p.companyId, claim.employee_id, "Your expense was reimbursed");
  revalidatePath("/app/finance/expenses");
}
