"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireLegal() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "legal") throw new Error("Not allowed");
  return p;
}

export async function createObligation(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;

  const dueDate = String(formData.get("due_date") ?? "").trim() || null;
  const obligationType = String(formData.get("obligation_type") ?? "statutory").trim();
  const evidence = String(formData.get("evidence") ?? "").trim() || null;
  const contractId = String(formData.get("contract_id") ?? "").trim() || null;

  if (!["contractual", "statutory"].includes(obligationType)) return;

  const insert: Record<string, unknown> = {
    company_id: p.companyId,
    description,
    due_date: dueDate,
    obligation_type: obligationType,
    evidence,
    status: "open",
  };
  if (contractId) insert.contract_id = contractId;

  const { data, error } = await supabaseWriteClient().from("obligations").insert(insert).select("id").maybeSingle();
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "obligation.created",
    entityType: "obligation",
    entityId: data?.id ?? null,
    payload: { description, obligation_type: obligationType, due_date: dueDate },
  });
  revalidatePath("/app/legal/obligations");
  revalidatePath("/app/legal");
}

export async function updateObligationStatus(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!id || !["open", "done", "overdue", "waived"].includes(status)) return;

  const { error } = await supabaseWriteClient()
    .from("obligations")
    .update({ status })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "obligation.status_updated",
    entityType: "obligation",
    entityId: id,
    payload: { status },
  });
  revalidatePath("/app/legal/obligations");
  revalidatePath("/app/legal");
}
