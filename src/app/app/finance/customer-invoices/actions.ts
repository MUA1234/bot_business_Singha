"use server";

import { revalidatePath } from "next/cache";
import { requireFinanceAccess } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { invoicePostingLines } from "@/accounting/posting-templates";
import { checkDraftJournal } from "@/accounting/manual-entry";
import { parseMoneyInput, lineTotal } from "@/lib/money";
import { resolveIdempotencyKey } from "@/lib/idempotency";

// WP D: central capability gate (membership capability grants; legacy finance dept still
// works during rollout; suspended members are denied). The DB enforces the specific
// finance.* capability authoritatively once RLS_WRITES is on.
const requireFinance = () => requireFinanceAccess("finance.invoice.create");

function invNumber(): string {
  const d = new Date();
  return `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/** Create a draft customer invoice (creates/reuses the customer by name). */
export async function createInvoice(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const customerName = String(formData.get("customer_name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!customerName || !description) return;
  const quantity = Math.max(1, Math.trunc(Number(formData.get("quantity") ?? 1) || 1));
  const unitPrice = parseMoneyInput(formData.get("unit_price"), "LKR");
  if (!unitPrice || unitPrice.isNegative()) return; // reject malformed/negative money
  const due_date = String(formData.get("due_date") ?? "").trim() || null;
  // Decimal money — never a JS float (Constitution invariant #11).
  const unit_price = unitPrice.toString();
  const amount = lineTotal(unitPrice, quantity).toString();

  // Reuse or create the customer.
  let customerId: string | null = null;
  const { data: existing } = await db.from("customers").select("id").eq("company_id", p.companyId).eq("name", customerName).maybeSingle();
  if (existing) customerId = existing.id;
  else {
    const { data: c } = await db.from("customers").insert({ company_id: p.companyId, name: customerName, status: "active" }).select("id").maybeSingle();
    customerId = c?.id ?? null;
  }
  if (!customerId) return;

  const { data: inv, error } = await db.from("customer_invoices").insert({
    company_id: p.companyId, customer_id: customerId, invoice_number: invNumber(),
    currency: "LKR", issue_date: new Date().toISOString().slice(0, 10), due_date,
    total_amount: amount, amount_settled: "0.00", status: "draft",
  }).select("id").maybeSingle();
  if (error || !inv) return;

  await db.from("customer_invoice_lines").insert({ invoice_id: inv.id, company_id: p.companyId, description, quantity, unit_price, amount });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "customer_invoice.created", entityType: "customer_invoice", entityId: inv.id, payload: { amount } });
  revalidatePath("/app/finance/customer-invoices");
}

/** Post the invoice to the ledger: Dr receivable, Cr income (atomic RPC). */
export async function postInvoice(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const id = String(formData.get("invoice_id") ?? "");
  const receivableCode = String(formData.get("receivable_code") ?? "").trim();
  const incomeCode = String(formData.get("income_code") ?? "").trim();
  if (!id || !receivableCode || !incomeCode) return;

  const { data: inv } = await db.from("customer_invoices")
    .select("id, invoice_number, currency, total_amount, status, journal_id")
    .eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!inv || inv.journal_id) return; // missing or already posted

  const lines = invoicePostingLines(receivableCode, incomeCode, String(inv.total_amount ?? 0), `Invoice ${inv.invoice_number}`);
  const check = checkDraftJournal(lines, inv.currency);
  if (!check.ready) return;

  const { data: journalId, error } = await db.rpc("post_manual_journal", {
    p_company: p.companyId, p_date: new Date().toISOString().slice(0, 10),
    p_currency: inv.currency, p_memo: `Customer invoice ${inv.invoice_number}`,
    p_posted_by: p.userId,
    p_lines: lines.map((l) => ({ account_code: l.account_code, debit: String(l.debit || "0"), credit: String(l.credit || "0"), description: l.description })),
    p_idempotency_key: `invoice_post:${id}`, // §WP2 — a retry re-uses the same journal
  });
  if (error) return;

  await db.from("customer_invoices").update({ journal_id: journalId, status: "issued" }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "customer_invoice.posted", entityType: "customer_invoice", entityId: id, payload: { journalId } });
  revalidatePath(`/app/finance/customer-invoices/${id}`);
  revalidatePath("/app/finance/customer-invoices");
}

/** Record a receipt against an invoice (Dr Cash, Cr AR). RECORDING ONLY — not a bank
 *  transfer. Atomic via the settle_customer_invoice RPC. */
export async function settleInvoice(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();
  const id = String(formData.get("invoice_id") ?? "");
  const amountMoney = parseMoneyInput(formData.get("amount"), "LKR");
  const cashCode = String(formData.get("cash_code") ?? "").trim();
  const arCode = String(formData.get("ar_code") ?? "").trim();
  if (!id || !cashCode || !arCode || !amountMoney || !amountMoney.isPositive()) return;
  const amount = Number(amountMoney.toString()); // validated decimal; RPC arg stays numeric

  // §WP-B idempotency is TRANSACTIONAL inside the RPC: the caller key is passed through,
  // so a retry (or double-submit) returns the same journal and re-applies nothing, and a
  // failed RPC never consumes the key. No fragile pre-claim. Audit is written in-RPC.
  const idemKey = resolveIdempotencyKey(String(formData.get("idem_token") ?? ""), [
    "settle_customer_invoice", id, amountMoney.toString(), new Date().toISOString().slice(0, 10),
  ]);

  const { error } = await db.rpc("settle_customer_invoice", {
    p_company: p.companyId, p_invoice: id, p_amount: amount,
    p_cash_code: cashCode, p_ar_code: arCode, p_by: p.userId,
    p_date: new Date().toISOString().slice(0, 10),
    p_idempotency_key: idemKey,
  });
  if (error) return;
  revalidatePath(`/app/finance/customer-invoices/${id}`);
  revalidatePath("/app/finance/customer-invoices");
}
