"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export interface CatalogState {
  error?: string;
  ok?: string;
}

async function requireCatalogEditor() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") {
    throw new Error("Not allowed");
  }
  return p;
}

export async function addProduct(_prev: CatalogState, formData: FormData): Promise<CatalogState> {
  const p = await requireCatalogEditor();
  const name = String(formData.get("name") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim() || null;
  const priceRaw = String(formData.get("unit_price") ?? "").trim();
  const currency = (String(formData.get("currency") ?? "LKR").trim() || "LKR").toUpperCase().slice(0, 3);
  if (!name) return { error: "Product name is required." };
  const unit_price = priceRaw === "" ? null : Number(priceRaw);
  if (unit_price !== null && (!isFinite(unit_price) || unit_price < 0))
    return { error: "Enter a valid price, or leave blank if the price varies." };

  const { error } = await supabaseAdmin().from("product_catalog").insert({
    company_id: p.companyId,
    name,
    sku,
    unit_price,
    currency,
    created_by: p.userId,
  });
  if (error) return { error: error.message };
  revalidatePath("/app/admin/catalog");
  return { ok: `Added ${name}.` };
}

export async function setProductActive(formData: FormData): Promise<void> {
  await requireCatalogEditor();
  const id = String(formData.get("id") ?? "");
  const is_active = formData.get("active") === "true";
  if (!id) return;
  await supabaseAdmin().from("product_catalog").update({ is_active }).eq("id", id);
  revalidatePath("/app/admin/catalog");
}
