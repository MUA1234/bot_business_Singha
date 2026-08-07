"use server";

import { revalidatePath } from "next/cache";
import { requireFinanceAccess } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput, lineTotal } from "@/lib/money";
import { resolveIdempotencyKey } from "@/lib/idempotency";

// WP D: central capability gate (see customer-invoices/actions.ts). DB enforces the
// specific finance.bill.* / finance.payment.record capability when RLS_WRITES is on.
const requireFinance = () => requireFinanceAccess("finance.bill.create");

function billNumber(): string {
  const d = new Date();
  return `BILL-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export async function createBill(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const supplierName = String(formData.get("supplier_name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!supplierName || !description) return;
  const quantity = Math.max(1, Math.trunc(Number(formData.get("quantity") ?? 1) || 1));
  const unitPrice = parseMoneyInput(formData.get("unit_price"), "LKR");
  if (!unitPrice || unitPrice.isNegative()) return; // reject malformed/negative money
  const due_date = String(formData.get("due_date") ?? "").trim() || null;
  // Decimal money — never a JS float (Constitution invariant #11).
  const unit_price = unitPrice.toString();
  const amount = lineTotal(unitPrice, quantity).toString();

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
    total_amount: amount, amount_settled: "0.00", status: "draft",
  }).select("id").maybeSingle();
  if (error || !bill) return;

  await db.from("supplier_bill_lines").insert({ bill_id: bill.id, company_id: p.companyId, description, quantity, unit_price, amount });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "supplier_bill.created", entityType: "supplier_bill", entityId: bill.id, payload: { amount } });
  revalidatePath("/app/finance/supplier-bills");
}

export async function postBill(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const id = String(formData.get("bill_id") ?? "");
  const expenseCode = String(formData.get("expense_code") ?? "").trim();
  const payableCode = String(formData.get("payable_code") ?? "").trim();
  if (!id || !expenseCode || !payableCode) return;

  // §WP-B: journal + bill status + audit are ONE transaction inside the RPC.
  const { error } = await db.rpc("post_supplier_bill", {
    p_company: p.companyId, p_bill: id,
    p_expense_code: expenseCode, p_payable_code: payableCode,
    p_by: p.userId, p_date: new Date().toISOString().slice(0, 10),
    p_idempotency_key: `bill_post:${id}`,
  });
  if (error) return;
  revalidatePath(`/app/finance/supplier-bills/${id}`);
  revalidatePath("/app/finance/supplier-bills");
}

/** Record a payment against a bill (Dr AP, Cr Cash). RECORDING ONLY — not a bank
 *  transfer. Atomic via the settle_supplier_bill RPC. */
export async function settleBill(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const id = String(formData.get("bill_id") ?? "");
  const amountMoney = parseMoneyInput(formData.get("amount"), "LKR");
  const apCode = String(formData.get("ap_code") ?? "").trim();
  const cashCode = String(formData.get("cash_code") ?? "").trim();
  if (!id || !apCode || !cashCode || !amountMoney || !amountMoney.isPositive()) return;
  const amount = Number(amountMoney.toString()); // validated decimal; RPC arg stays numeric

  // §WP-B idempotency is TRANSACTIONAL inside the RPC (caller key passed through). A
  // retry returns the same journal and re-applies nothing; a failed RPC never consumes
  // the key. Audit is written in-RPC.
  const idemKey = resolveIdempotencyKey(String(formData.get("idem_token") ?? ""), [
    "settle_supplier_bill", id, amountMoney.toString(), new Date().toISOString().slice(0, 10),
  ]);

  const { error } = await db.rpc("settle_supplier_bill", {
    p_company: p.companyId, p_bill: id, p_amount: amount,
    p_ap_code: apCode, p_cash_code: cashCode, p_by: p.userId,
    p_date: new Date().toISOString().slice(0, 10),
    p_idempotency_key: idemKey,
  });
  if (error) return;
  revalidatePath(`/app/finance/supplier-bills/${id}`);
  revalidatePath("/app/finance/supplier-bills");
}
