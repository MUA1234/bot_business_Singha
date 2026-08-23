"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { dec, decSum, parseMoneyInput } from "@/lib/money";

async function requireProc() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "procurement") throw new Error("Not allowed");
  return p;
}

function poNumber(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `PO-${ymd}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export async function createPurchaseOrder(formData: FormData): Promise<void> {
  const p = await requireProc();
  const title = String(formData.get("title") ?? "").trim();
  const db = supabaseWriteClient();
  const { data, error } = await db
    .from("purchase_orders")
    .insert({ company_id: p.companyId, po_number: poNumber(), status: "draft", total_amount: "0.00" })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "purchase_order.created", entityType: "purchase_order", entityId: data?.id ?? null, payload: { title } });
  revalidatePath("/app/procurement/purchase-orders");
}

/** Confirm a PO belongs to the caller's company. */
async function poInCompany(id: string, companyId: string) {
  const { data } = await supabaseWriteClient().from("purchase_orders").select("id").eq("id", id).eq("company_id", companyId).maybeSingle();
  return data ?? null;
}

async function recomputePoTotalAndStatus(poId: string, companyId: string) {
  const db = supabaseWriteClient();
  const { data: lines } = await db.from("po_lines").select("quantity, unit_price, received_quantity").eq("purchase_order_id", poId).eq("company_id", companyId);
  const rows = lines ?? [];
  // Money × quantity in Decimal — never a JS float (Constitution invariant #11).
  const total = decSum(rows.map((l: any) => dec(l.unit_price).times(Math.max(0, Math.trunc(Number(l.quantity) || 0)))));
  const anyReceived = rows.some((l: any) => Number(l.received_quantity ?? 0) > 0);
  const allReceived = rows.length > 0 && rows.every((l: any) => Number(l.received_quantity ?? 0) >= Number(l.quantity ?? 0));
  const status = allReceived ? "received" : anyReceived ? "part_received" : "draft";
  await db.from("purchase_orders").update({ total_amount: total.toFixed(), status }).eq("id", poId).eq("company_id", companyId);
}

export async function addPoLine(formData: FormData): Promise<void> {
  const p = await requireProc();
  const poId = String(formData.get("po_id") ?? "");
  if (!(await poInCompany(poId, p.companyId))) return;
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  const quantity = Math.max(0, Math.trunc(Number(formData.get("quantity") ?? 0) || 0));
  // Decimal money via parseMoneyInput — malformed/negative price is rejected like other invalid input.
  const unitPrice = parseMoneyInput(formData.get("unit_price"), "LKR");
  if (!unitPrice || unitPrice.isNegative()) return;

  await supabaseWriteClient().from("po_lines").insert({
    purchase_order_id: poId, company_id: p.companyId, description, quantity, unit_price: unitPrice.toString(), received_quantity: 0,
  });
  await recomputePoTotalAndStatus(poId, p.companyId);
  revalidatePath(`/app/procurement/purchase-orders/${poId}`);
}

export async function recordLineReceipt(formData: FormData): Promise<void> {
  const p = await requireProc();
  const poId = String(formData.get("po_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  const received = Math.max(0, Number(formData.get("received") ?? 0) || 0);
  if (!(await poInCompany(poId, p.companyId))) return;

  // Line must belong to this PO + company.
  const { data: line } = await supabaseWriteClient()
    .from("po_lines").select("id").eq("id", lineId).eq("purchase_order_id", poId).eq("company_id", p.companyId).maybeSingle();
  if (!line) return;

  await supabaseWriteClient().from("po_lines").update({ received_quantity: received }).eq("id", lineId).eq("company_id", p.companyId);
  await supabaseWriteClient().from("goods_receipts").insert({ company_id: p.companyId, purchase_order_id: poId, received_by: p.userId });
  await recomputePoTotalAndStatus(poId, p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "goods.received", entityType: "purchase_order", entityId: poId, payload: { lineId, received } });
  revalidatePath(`/app/procurement/purchase-orders/${poId}`);
}

export async function updateExpectedPaymentDate(formData: FormData): Promise<void> {
  const p = await requireProc();
  const poId = String(formData.get("po_id") ?? "");
  if (!(await poInCompany(poId, p.companyId))) return;

  const raw = String(formData.get("expected_payment_date") ?? "").trim();
  const expectedPaymentDate = raw === "" ? null : raw;
  // Reject obvious malformed dates before touching the DB.
  if (expectedPaymentDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expectedPaymentDate)) return;

  const { error } = await supabaseWriteClient()
    .from("purchase_orders")
    .update({ expected_payment_date: expectedPaymentDate })
    .eq("id", poId)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "purchase_order.expected_payment_date.updated",
    entityType: "purchase_order",
    entityId: poId,
    payload: { expected_payment_date: expectedPaymentDate },
  });
  revalidatePath(`/app/procurement/purchase-orders/${poId}`);
  revalidatePath("/app/procurement/purchase-orders");
  revalidatePath("/app/command");
}
