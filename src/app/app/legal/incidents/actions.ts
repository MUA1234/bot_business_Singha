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

export async function createIncident(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;

  const description = String(formData.get("description") ?? "").trim() || null;
  const severity = String(formData.get("severity") ?? "medium").trim();
  const status = String(formData.get("status") ?? "open").trim();
  const occurredAt = String(formData.get("occurred_at") ?? "").trim() || null;
  const rootCause = String(formData.get("root_cause") ?? "").trim() || null;
  const correctiveAction = String(formData.get("corrective_action") ?? "").trim() || null;
  const evidence = String(formData.get("evidence") ?? "").trim() || null;

  if (!["low", "medium", "high", "critical"].includes(severity)) return;
  if (!["open", "investigating", "resolved", "closed"].includes(status)) return;

  const { data, error } = await supabaseWriteClient()
    .from("incidents")
    .insert({
      company_id: p.companyId,
      title,
      description,
      severity,
      status,
      occurred_at: occurredAt,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      evidence,
    })
    .select("id")
    .maybeSingle();
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "incident.created",
    entityType: "incident",
    entityId: data?.id ?? null,
    payload: { title, severity, status },
  });
  revalidatePath("/app/legal/incidents");
  revalidatePath("/app/legal");
}

export async function updateIncidentStatus(formData: FormData): Promise<void> {
  const p = await requireLegal();
  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!id || !["open", "investigating", "resolved", "closed"].includes(status)) return;

  const { error } = await supabaseWriteClient()
    .from("incidents")
    .update({ status })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "incident.status_updated",
    entityType: "incident",
    entityId: id,
    payload: { status },
  });
  revalidatePath("/app/legal/incidents");
  revalidatePath("/app/legal");
}
