"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { parseBankLines } from "@/modules/finance/bank-import";
import { sha256 } from "@/lib/ids";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

/** Import pasted bank statement lines into bank_transactions. */
export async function importBankTransactions(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const bankAccountId = String(formData.get("bank_account_id") ?? "");
  const text = String(formData.get("lines") ?? "");
  if (!bankAccountId) return;

  // Bank account must belong to the caller's company; take its currency.
  const { data: acct } = await db.from("bank_accounts").select("id, currency").eq("id", bankAccountId).eq("company_id", p.companyId).maybeSingle();
  if (!acct) return;

  const { rows } = parseBankLines(text);
  if (rows.length === 0) return;

  const toInsert = rows.map((r) => ({
    company_id: p.companyId,
    bank_account_id: bankAccountId,
    txn_date: r.date,
    amount: r.amount,
    currency: acct.currency,
    description: r.description,
    fingerprint: sha256(`${bankAccountId}|${r.date}|${r.amount}|${r.description}`),
    amount_matched: 0,
    status: "unmatched",
  }));
  const { error } = await db.from("bank_transactions").insert(toInsert);
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "bank.imported", entityType: "bank_account", entityId: bankAccountId, payload: { count: toInsert.length } });
  revalidatePath("/app/finance/reconciliation");
}

/** Confirm a suggested match: record it and mark the bank transaction matched. */
export async function confirmMatch(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const bankTxnId = String(formData.get("bank_txn_id") ?? "");
  const targetType = String(formData.get("target_type") ?? "");
  const targetId = String(formData.get("target_id") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  if (!bankTxnId || !["payment", "receipt", "journal_line"].includes(targetType) || !targetId || !(amount > 0)) return;

  // Bank transaction must belong to the company and not already be matched.
  const { data: txn } = await db.from("bank_transactions").select("id, status").eq("id", bankTxnId).eq("company_id", p.companyId).maybeSingle();
  if (!txn || txn.status === "matched") return;

  const { error } = await db.from("reconciliation_matches").insert({
    company_id: p.companyId, bank_transaction_id: bankTxnId, target_type: targetType, target_id: targetId,
    amount, confirmed_by: p.userId, is_ai_suggested: true,
  });
  if (error) return;
  await db.from("bank_transactions").update({ amount_matched: amount, status: "matched" }).eq("id", bankTxnId).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "bank.matched", entityType: "bank_transaction", entityId: bankTxnId, payload: { targetType, targetId } });
  revalidatePath("/app/finance/reconciliation");
}
