"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { computeCashPosition, type CashMovement } from "@/modules/finance/cash-position";
import { cashVariance } from "@/modules/finance/petty-cash";
import { parseMoneyInput } from "@/lib/money";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

/** Record a physical cash count and store the variance vs the book balance. */
export async function recordCashCount(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const cashAccountId = String(formData.get("cash_account_id") ?? "");
  const countedRaw = String(formData.get("counted_amount") ?? "").trim();
  if (!cashAccountId || !/^\d+(\.\d+)?$/.test(countedRaw)) return; // non-negative decimal only

  const { data: acct } = await db.from("cash_accounts").select("id, currency, opening_balance").eq("id", cashAccountId).eq("company_id", p.companyId).maybeSingle();
  if (!acct) return;
  // Decimal money at the account's currency — never a JS float.
  const countedMoney = parseMoneyInput(countedRaw, acct.currency);
  if (!countedMoney) return;
  const counted = countedMoney.toString();

  // Book balance = opening + non-void payments in/out on this cash account.
  const { data: pmts } = await db.from("payments").select("direction, amount, cash_account_id, status").eq("company_id", p.companyId).eq("cash_account_id", cashAccountId).neq("status", "void");
  const movements: CashMovement[] = (pmts ?? []).map((m: any): CashMovement => ({ accountId: cashAccountId, direction: m.direction === "in" ? "in" : "out", amount: String(m.amount ?? 0) }));
  const book = computeCashPosition([{ id: cashAccountId, name: "cash", currency: acct.currency, openingBalance: String(acct.opening_balance ?? 0) }], movements).totalsByCurrency[acct.currency] ?? "0";
  const variance = cashVariance(String(counted), book, acct.currency);

  await db.from("cash_counts").insert({ company_id: p.companyId, cash_account_id: cashAccountId, counted_amount: counted, variance, counted_by: p.userId });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "cash_count.recorded", entityType: "cash_account", entityId: cashAccountId, payload: { counted, book, variance } });
  revalidatePath("/app/finance/cash-counts");
}
