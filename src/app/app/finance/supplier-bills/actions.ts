"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { billPostingLines } from "@/accounting/posting-templates";
import { checkDraftJournal } from "@/accounting/manual-entry";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

function billNumber(): string {
  const d = new Date();
  return `BILL-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export async function createBill(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const supplierName = String(formData.get("supplier_name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!supplierName || !description) return;
  const quantity = Math.max(0, Number(formData.get("quantity") ?? 1) || 1);
  const unit_price = Math.max(0, Number(formData.get("unit_price") ?? 0) || 0);
  const due_date = String(formData.get("due_date") ?? "").trim() || null;
  const amount = quantity * unit_price;

  let supplierId: string | null = null;
  const { data: existing } = await db.from("suppliers").select("id").eq("company_id", p.companyId).eq("name", supplierName).maybeSingle();
  if (existing) supplierId = existing.id;
  else {
    const { data: s } = await db.from("suppliers").insert({ company_id: p.companyId, name: supplierName, status: "active" }).select("id").maybeSingle();
    supplierId = s?.id ?? null;
  }
  if (!supplierId) return;

  const { data: bill, error } = await db.from("supplier_bills").insert({
    company_id: p.companyId, supplier_id: supplierId, bill_number: billNumber(),
    currency: "LKR", issue_date: new Date().toISOString().slice(0, 10), due_date,
    total_amount: amount, amount_settled: 0, status: "draft",
  }).select("id").maybeSingle();
  if (error || !bill) return;

  await db.from("supplier_bill_lines").insert({ bill_id: bill.id, company_id: p.companyId, description, quantity, unit_price, amount });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "supplier_bill.created", entityType: "supplier_bill", entityId: bill.id, payload: { amount } });
  revalidatePath("/app/finance/supplier-bills");
}

export async function postBill(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const id = String(formData.get("bill_id") ?? "");
  const expenseCode = String(formData.get("expense_code") ?? "").trim();
  const payableCode = String(formData.get("payable_code") ?? "").trim();
  if (!id || !expenseCode || !payableCode) return;

  const { data: bill } = await db.from("supplier_bills")
    .select("id, bill_number, currency, total_amount, journal_id")
    .eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!bill || bill.journal_id) return;

  const lines = billPostingLines(expenseCode, payableCode, String(bill.total_amount ?? 0), `Bill ${bill.bill_number}`);
  if (!checkDraftJournal(lines, bill.currency).ready) return;

  const { data: journalId, error } = await db.rpc("post_manual_journal", {
    p_company: p.companyId, p_date: new Date().toISOString().slice(0, 10),
    p_currency: bill.currency, p_memo: `Supplier bill ${bill.bill_number}`, p_posted_by: p.userId,
    p_lines: lines.map((l) => ({ account_code: l.account_code, debit: String(l.debit || "0"), credit: String(l.credit || "0"), description: l.description })),
  });
  if (error) return;

  await db.from("supplier_bills").update({ journal_id: journalId, status: "approved" }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "supplier_bill.posted", entityType: "supplier_bill", entityId: id, payload: { journalId } });
  revalidatePath(`/app/finance/supplier-bills/${id}`);
  revalidatePath("/app/finance/supplier-bills");
}

/** Record a payment against a bill (Dr AP, Cr Cash). RECORDING ONLY — not a bank
 *  transfer. Atomic via the settle_supplier_bill RPC. */
export async function settleBill(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const id = String(formData.get("bill_id") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const apCode = String(formData.get("ap_code") ?? "").trim();
  const cashCode = String(formData.get("cash_code") ?? "").trim();
  if (!id || !apCode || !cashCode || !(amount > 0)) return;

  const { error } = await db.rpc("settle_supplier_bill", {
    p_company: p.companyId, p_bill: id, p_amount: amount,
    p_ap_code: apCode, p_cash_code: cashCode, p_by: p.userId,
    p_date: new Date().toISOString().slice(0, 10),
  });
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "supplier_bill.payment_recorded", entityType: "supplier_bill", entityId: id, payload: { amount } });
  revalidatePath(`/app/finance/supplier-bills/${id}`);
  revalidatePath("/app/finance/supplier-bills");
}
