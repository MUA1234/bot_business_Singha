"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput } from "@/lib/money";

async function requireProc() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "procurement") throw new Error("Not allowed");
  return p;
}

export async function createItem(formData: FormData): Promise<void> {
  const p = await requireProc();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const sku = String(formData.get("sku") ?? "").trim() || null;
  const unit = String(formData.get("unit") ?? "").trim() || null;
  const reorder_level = Math.max(0, Number(formData.get("reorder_level") ?? 0) || 0);
  // Decimal money — never a JS float. Malformed/negative costs fail like other invalid input.
  const unitCost = parseMoneyInput(formData.get("unit_cost"), "LKR");
  if (!unitCost || unitCost.isNegative()) return;
  const unit_cost = unitCost.toString();
  const quantity_on_hand = Math.max(0, Number(formData.get("quantity_on_hand") ?? 0) || 0);

  const { data, error } = await supabaseWriteClient().from("inventory_items")
    .insert({ company_id: p.companyId, name, sku, unit, reorder_level, unit_cost, quantity_on_hand, created_by: p.userId })
    .select("id").maybeSingle();
  if (error) return; // e.g. duplicate SKU
  if (quantity_on_hand > 0 && data) {
    await supabaseWriteClient().from("stock_movements").insert({ company_id: p.companyId, item_id: data.id, direction: "in", quantity: quantity_on_hand, reason: "opening balance", created_by: p.userId });
  }
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "inventory_item.created", entityType: "inventory_item", entityId: data?.id ?? null, payload: { name } });
  revalidatePath("/app/procurement/inventory");
}

/** Record a stock movement (in/out/adjust) and update quantity on hand atomically-ish. */
export async function moveStock(formData: FormData): Promise<void> {
  const p = await requireProc();
  const db = supabaseWriteClient();
  const itemId = String(formData.get("item_id") ?? "");
  const direction = String(formData.get("direction") ?? "");
  const quantity = Number(formData.get("quantity") ?? 0);
  if (!itemId || !["in", "out", "adjust"].includes(direction) || !(quantity > 0)) return;

  const { data: item } = await db.from("inventory_items").select("id, quantity_on_hand").eq("id", itemId).eq("company_id", p.companyId).maybeSingle();
  if (!item) return;

  const current = Number(item.quantity_on_hand ?? 0);
  const next = direction === "in" ? current + quantity : direction === "out" ? Math.max(0, current - quantity) : quantity;

  await db.from("stock_movements").insert({ company_id: p.companyId, item_id: itemId, direction, quantity, reason: String(formData.get("reason") ?? "").trim() || null, created_by: p.userId });
  await db.from("inventory_items").update({ quantity_on_hand: next }).eq("id", itemId).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `stock.${direction}`, entityType: "inventory_item", entityId: itemId, payload: { quantity, next } });
  revalidatePath("/app/procurement/inventory");
}
