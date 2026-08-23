"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireAdminDirective() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "admin") throw new Error("Not allowed");
  return p;
}

export async function createDirective(formData: FormData): Promise<void> {
  const p = await requireAdminDirective();
  const title = String(formData.get("title") ?? "").trim();
  const issued_to = String(formData.get("issued_to") ?? "").trim();
  const response_required_by = String(formData.get("response_required_by") ?? "").trim();
  if (!title || !issued_to || !response_required_by) return;
  const body = String(formData.get("body") ?? "").trim() || null;

  const { data, error } = await supabaseWriteClient()
    .from("management_directives")
    .insert({
      company_id: p.companyId,
      title,
      body,
      issued_by: p.userId,
      issued_to,
      response_required_by,
      status: "issued",
    })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "management_directive.created",
    entityType: "management_directive",
    entityId: data?.id ?? null,
    payload: { title, issued_to },
  });
  revalidatePath("/app/admin/directives");
}

export async function acknowledgeDirective(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const id = String(formData.get("id") ?? "").trim();
  const response = String(formData.get("response") ?? "").trim() || null;
  if (!id) return;

  const { error } = await supabaseWriteClient()
    .from("management_directives")
    .update({
      status: "acknowledged",
      response,
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("issued_to", p.userId);
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "management_directive.acknowledged",
    entityType: "management_directive",
    entityId: id,
    payload: { response },
  });
  revalidatePath("/app/admin/directives");
}

export async function closeDirective(formData: FormData): Promise<void> {
  const p = await requireAdminDirective();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  const { error } = await supabaseWriteClient()
    .from("management_directives")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "management_directive.closed",
    entityType: "management_directive",
    entityId: id,
    payload: {},
  });
  revalidatePath("/app/admin/directives");
}
