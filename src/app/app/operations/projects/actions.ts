"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

const PROJECT_STATUSES = new Set(["active", "on_hold", "completed", "cancelled"]);

async function requireOps() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "operations") throw new Error("Not allowed");
  return p;
}

/** Operations staff or an admin may update a project's lifecycle status. */
export async function updateProjectStatus(formData: FormData): Promise<void> {
  const p = await requireOps();

  const id = String(formData.get("project_id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!id || !PROJECT_STATUSES.has(status)) return;

  // Load current status for the audit payload; fail closed if not in company.
  const { data: project } = await supabaseWriteClient()
    .from("projects")
    .select("status")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!project) return;

  const { error } = await supabaseWriteClient()
    .from("projects")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project.status_updated",
    entityType: "project",
    entityId: id,
    payload: { from: project.status, to: status },
  });

  revalidatePath(`/app/operations/projects/${id}`);
  revalidatePath("/app/operations/projects");
}
