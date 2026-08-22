"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { resolvePriceConfirmation } from "@/lib/quotations";

async function requirePricer() {
  const p = await requireProfile();
  if (!p.isAdmin && !["sales", "finance"].includes(p.department)) throw new Error("Not allowed");
  return p;
}

/** Fill in the confirmed unit price; finalizes + sends the quote if now complete. */
export async function resolvePrice(formData: FormData): Promise<void> {
  const p = await requirePricer();
  const confirmationId = String(formData.get("confirmation_id") ?? "");
  // Money never passes through a JS float: validate the raw input as a decimal string and hand the
  // canonical string down — the quotation currency is applied inside resolvePriceConfirmation.
  const raw = String(formData.get("price") ?? "").trim();
  if (!confirmationId || !/^\d+(\.\d+)?$/.test(raw)) return;

  await resolvePriceConfirmation({
    companyId: p.companyId,
    confirmationId,
    resolvedPrice: raw,
    userId: p.userId,
  });

  revalidatePath("/app/sales/price-requests");
  revalidatePath("/app/finance/price-requests");
  revalidatePath("/app/sales/quotations");
}

/** Dismiss a confirmation (e.g. item removed / handled manually). */
export async function dismissPrice(formData: FormData): Promise<void> {
  const p = await requirePricer();
  const confirmationId = String(formData.get("confirmation_id") ?? "");
  if (!confirmationId) return;
  await supabaseWriteClient()
    .from("price_confirmations")
    .update({ status: "dismissed", resolved_by: p.userId, resolved_at: new Date().toISOString() })
    .eq("id", confirmationId)
    .eq("company_id", p.companyId);
  revalidatePath("/app/sales/price-requests");
  revalidatePath("/app/finance/price-requests");
}
