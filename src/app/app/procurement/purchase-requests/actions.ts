"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireProc() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "procurement") throw new Error("Not allowed");
  return p;
}

const STATUSES = ["draft", "submitted", "approved", "rejected", "ordered", "closed"] as const;

export async function createPurchaseRequest(formData: FormData): Promise<void> {
  const p = await requireProc();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const description = String(formData.get("description") ?? "").trim() || null;
  const estimated_cost = Number(formData.get("estimated_cost") ?? 0) || null;

  const { data, error } = await supabaseWriteClient()
    .from("purchase_requests")
    .insert({ company_id: p.companyId, title, description, estimated_cost, status: "draft", requested_by: p.userId })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "purchase_request.created", entityType: "purchase_request", entityId: data?.id ?? null, payload: { title } });
  revalidatePath("/app/procurement/purchase-requests");
}

export async function setPurchaseRequestStatus(formData: FormData): Promise<void> {
  const p = await requireProc();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !STATUSES.includes(status as any)) return;

  const { data: target } = await supabaseWriteClient()
    .from("purchase_requests").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!target) return;

  await supabaseWriteClient().from("purchase_requests").update({ status }).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `purchase_request.${status}`, entityType: "purchase_request", entityId: id });
  revalidatePath("/app/procurement/purchase-requests");
}
