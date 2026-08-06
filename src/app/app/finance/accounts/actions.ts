"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput, Money } from "@/lib/money";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

export async function createBankAccount(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const currency = (String(formData.get("currency") ?? "LKR").trim() || "LKR").toUpperCase().slice(0, 3);
  const opening = (parseMoneyInput(formData.get("opening_balance"), currency) ?? Money.of("0", currency)).toString();
  const gl = String(formData.get("gl_account_code") ?? "").trim() || null;
  const { error } = await supabaseWriteClient().from("bank_accounts").insert({ company_id: p.companyId, name, currency, opening_balance: opening, gl_account_code: gl, status: "active" });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "bank_account.created", entityType: "bank_account", entityId: name, payload: { currency } });
  revalidatePath("/app/finance/accounts");
}

export async function createCashAccount(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const currency = (String(formData.get("currency") ?? "LKR").trim() || "LKR").toUpperCase().slice(0, 3);
  const opening = (parseMoneyInput(formData.get("opening_balance"), currency) ?? Money.of("0", currency)).toString();
  const gl = String(formData.get("gl_account_code") ?? "").trim() || null;
  const { error } = await supabaseWriteClient().from("cash_accounts").insert({ company_id: p.companyId, name, currency, opening_balance: opening, gl_account_code: gl, status: "active" });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "cash_account.created", entityType: "cash_account", entityId: name, payload: { currency } });
  revalidatePath("/app/finance/accounts");
}
