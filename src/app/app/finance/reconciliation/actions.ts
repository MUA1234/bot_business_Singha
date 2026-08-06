"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { parseBankLines } from "@/modules/finance/bank-import";
import { sha256 } from "@/lib/ids";
import { parseMoneyInput } from "@/lib/money";
import { validateReconciliation, type ReconTargetType } from "@/modules/finance/reconcile-validate";

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
  const amountMoney = parseMoneyInput(formData.get("amount"), "LKR");
  if (!bankTxnId || !["payment", "receipt", "journal_line"].includes(targetType) || !targetId || !amountMoney || !amountMoney.isPositive()) return;
  const amount = amountMoney.toString(); // decimal string, never a JS float

  // Bank transaction must belong to the company and not already be matched.
  const { data: txn } = await db.from("bank_transactions").select("id, status, amount, currency, company_id").eq("id", bankTxnId).eq("company_id", p.companyId).maybeSingle();
  if (!txn || txn.status === "matched") return;

  // §WP2.7 — validate the TARGET server-side; never trust the submitted id/amount.
  const table = targetType === "payment" ? "payments" : targetType === "receipt" ? "receipts" : "journal_lines";
  const { data: exists } = await db.from(table).select("id, company_id").eq("id", targetId).eq("company_id", p.companyId).maybeSingle();
  if (!exists) return; // target missing or in another company → reject

  // Best-effort richer target fields (currency/amount) for a fuller check.
  let tCurrency: string | undefined, tAmount: string | undefined;
  if (targetType !== "journal_line") {
    const { data: rich } = await db.from(table).select("amount, currency").eq("id", targetId).eq("company_id", p.companyId).maybeSingle();
    if (rich) {
      tCurrency = (rich as any).currency ?? undefined;
      tAmount = (rich as any).amount != null ? String((rich as any).amount) : undefined;
    }
  }

  const check = validateReconciliation(
    {
      callerCompanyId: p.companyId,
      bankTxn: { companyId: (txn as any).company_id, currency: (txn as any).currency, amount: String((txn as any).amount ?? "0") },
      target: { type: targetType as ReconTargetType, companyId: (exists as any).company_id, currency: tCurrency, amount: tAmount },
      matchAmount: amount,
    },
    { checkDirection: false }, // bank sign convention not yet trusted here
  );
  if (!check.ok) return; // invalid match → reject

  const { error } = await db.from("reconciliation_matches").insert({
    company_id: p.companyId, bank_transaction_id: bankTxnId, target_type: targetType, target_id: targetId,
    amount, confirmed_by: p.userId, is_ai_suggested: true,
  });
  if (error) return;
  await db.from("bank_transactions").update({ amount_matched: amount, status: "matched" }).eq("id", bankTxnId).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "bank.matched", entityType: "bank_transaction", entityId: bankTxnId, payload: { targetType, targetId } });
  revalidatePath("/app/finance/reconciliation");
}
