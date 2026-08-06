"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { assessObjective } from "@/management/ai-manager/objective-status";

export async function createObjective(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const metric = String(formData.get("metric") ?? "").trim() || null;
  const unit = String(formData.get("unit") ?? "").trim() || null;
  const target_value = Number(formData.get("target_value") ?? 0) || 0;
  const period_start = String(formData.get("period_start") ?? "").trim() || null;
  const period_end = String(formData.get("period_end") ?? "").trim() || null;

  const { error } = await supabaseWriteClient().from("objectives").insert({
    company_id: admin.companyId, title, metric, unit, target_value, current_value: 0,
    period_start, period_end, status: "on_track", owner_id: admin.userId,
  });
  if (error) return;
  await writeAudit({ companyId: admin.companyId, actorId: admin.userId, action: "objective.created", entityType: "objective", entityId: title });
  revalidatePath("/app/admin/objectives");
}

export async function updateObjectiveProgress(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const current = Number(formData.get("current_value") ?? NaN);
  if (!id || !Number.isFinite(current)) return;

  const { data: obj } = await supabaseWriteClient().from("objectives")
    .select("target_value, period_start, period_end").eq("id", id).eq("company_id", admin.companyId).maybeSingle();
  if (!obj) return;

  const { status } = assessObjective({ target: Number(obj.target_value ?? 0), current, periodStart: obj.period_start, periodEnd: obj.period_end });
  await supabaseWriteClient().from("objectives").update({ current_value: current, status }).eq("id", id).eq("company_id", admin.companyId);
  await writeAudit({ companyId: admin.companyId, actorId: admin.userId, action: "objective.progress", entityType: "objective", entityId: id, payload: { current, status } });
  revalidatePath("/app/admin/objectives");
}
