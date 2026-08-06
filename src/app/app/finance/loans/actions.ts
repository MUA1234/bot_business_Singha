"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { amortizationSchedule } from "@/accounting/amortization";
import { parseMoneyInput } from "@/lib/money";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

/** Create a loan and generate its amortization schedule. */
export async function createLoan(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const counterparty = String(formData.get("counterparty") ?? "").trim() || null;
  const principalMoney = parseMoneyInput(formData.get("principal"), "LKR");
  const interest_rate = Math.max(0, Number(formData.get("interest_rate") ?? 0) || 0);
  const start_date = String(formData.get("start_date") ?? "").trim();
  const termMonths = Math.max(1, Math.trunc(Number(formData.get("term_months") ?? 0) || 0));
  if (!principalMoney || !principalMoney.isPositive() || !start_date || !(termMonths > 0)) return;
  const principal = principalMoney.toString(); // decimal string, never a JS float

  const { data: loan, error } = await db.from("loans")
    .insert({ company_id: p.companyId, counterparty, principal, currency: "LKR", start_date, interest_rate, status: "active" })
    .select("id").maybeSingle();
  if (error || !loan) return;

  const schedule = amortizationSchedule(String(principal), interest_rate, termMonths, start_date).map((i) => ({
    company_id: p.companyId, loan_id: loan.id, due_date: i.dueDate, principal_due: i.principal, interest_due: i.interest, status: "scheduled",
  }));
  await db.from("loan_schedules").insert(schedule);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "loan.created", entityType: "loan", entityId: loan.id, payload: { principal, termMonths } });
  revalidatePath("/app/finance/loans");
}
