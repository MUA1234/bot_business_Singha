"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

const VALID_DIRECTIVE_ACTIONS = ["approve", "reject", "hold", "proceed", "stop"] as const;
type DirectiveAction = (typeof VALID_DIRECTIVE_ACTIONS)[number];

async function requireAdminDirective() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "admin") throw new Error("Not allowed");
  return p;
}

function parseAction(value: string | null): DirectiveAction | null {
  if (!value) return null;
  if (VALID_DIRECTIVE_ACTIONS.includes(value as DirectiveAction)) return value as DirectiveAction;
  return null;
}

export async function createDirective(formData: FormData): Promise<void> {
  const p = await requireAdminDirective();
  const title = String(formData.get("title") ?? "").trim();
  const issued_to = String(formData.get("issued_to") ?? "").trim();
  const response_required_by = String(formData.get("response_required_by") ?? "").trim();
  if (!title || !issued_to || !response_required_by) return;

  const body = String(formData.get("body") ?? "").trim() || null;
  const target_type = String(formData.get("target_type") ?? "").trim() || null;
  const target_id = String(formData.get("target_id") ?? "").trim() || null;
  const action = parseAction(String(formData.get("action") ?? "").trim() || null);

  // If an action was supplied it must be in the canonical set; fail closed.
  if (String(formData.get("action") ?? "").trim() && !action) return;

  const insert: Record<string, unknown> = {
    company_id: p.companyId,
    title,
    body,
    issued_by: p.userId,
    issued_to,
    response_required_by,
    status: "issued",
  };
  if (target_type) insert.target_type = target_type;
  if (target_id) insert.target_id = target_id;
  if (action) insert.action = action;

  const { data, error } = await supabaseWriteClient()
    .from("management_directives")
    .insert(insert)
    .select("id")
    .maybeSingle();
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "management_directive.created",
    entityType: "management_directive",
    entityId: data?.id ?? null,
    payload: { title, issued_to, target_type, target_id, action },
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

export async function resolveDirectiveConflict(formData: FormData): Promise<void> {
  const p = await requireAdminDirective();
  const id = String(formData.get("id") ?? "").trim();
  const resolution = String(formData.get("resolution") ?? "").trim();
  if (!id || !resolution) return;

  const { data: conflict, error: readError } = await supabaseWriteClient()
    .from("management_directive_conflicts")
    .select("company_id, directive_a_id, directive_b_id")
    .eq("id", id)
    .maybeSingle();
  if (readError || !conflict || conflict.company_id !== p.companyId) return;

  const { error } = await supabaseWriteClient()
    .from("management_directive_conflicts")
    .update({
      status: "resolved",
      resolution,
      resolved_by: p.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "management_directive_conflict.resolved",
    entityType: "management_directive_conflict",
    entityId: id,
    payload: {
      resolution,
      directive_a_id: conflict.directive_a_id,
      directive_b_id: conflict.directive_b_id,
    },
  });
  revalidatePath("/app/admin/directives");
}
