"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

async function requireAdminIntegration() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "admin") throw new Error("Not allowed");
  return p;
}

export async function createIntegration(formData: FormData): Promise<void> {
  const p = await requireAdminIntegration();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const description = String(formData.get("description") ?? "").trim() || null;

  const { data, error } = await supabaseWriteClient()
    .from("integrations")
    .insert({ company_id: p.companyId, name, description, status: "active" })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "integration.created",
    entityType: "integration",
    entityId: data?.id ?? null,
    payload: { name },
  });
  revalidatePath("/app/admin/integrations");
}

export async function createConnector(formData: FormData): Promise<void> {
  const p = await requireAdminIntegration();
  const integration_id = String(formData.get("integration_id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!integration_id || !name) return;
  const direction = String(formData.get("direction") ?? "bidirectional").trim() as "inbound" | "outbound" | "bidirectional";
  const protocol = String(formData.get("protocol") ?? "https").trim();

  const { data, error } = await supabaseWriteClient()
    .from("connectors")
    .insert({ company_id: p.companyId, integration_id, name, direction, protocol, status: "active" })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "connector.created",
    entityType: "connector",
    entityId: data?.id ?? null,
    payload: { name, integration_id },
  });
  revalidatePath("/app/admin/integrations");
}

export async function createEventContract(formData: FormData): Promise<void> {
  const p = await requireAdminIntegration();
  const connector_id = String(formData.get("connector_id") ?? "").trim();
  const event_type = String(formData.get("event_type") ?? "").trim();
  if (!connector_id || !event_type) return;
  const schema_ref = String(formData.get("schema_ref") ?? "").trim() || null;
  const signature_required = formData.get("signature_required") === "on";
  const replay_protection = formData.get("replay_protection") === "on";

  const { data, error } = await supabaseWriteClient()
    .from("integration_event_contracts")
    .insert({ company_id: p.companyId, connector_id, event_type, schema_ref, signature_required, replay_protection })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "integration_event_contract.created",
    entityType: "integration_event_contract",
    entityId: data?.id ?? null,
    payload: { event_type, connector_id },
  });
  revalidatePath("/app/admin/integrations");
}

export async function createCommandContract(formData: FormData): Promise<void> {
  const p = await requireAdminIntegration();
  const connector_id = String(formData.get("connector_id") ?? "").trim();
  const command_type = String(formData.get("command_type") ?? "").trim();
  if (!connector_id || !command_type) return;
  const schema_ref = String(formData.get("schema_ref") ?? "").trim() || null;
  const signature_required = formData.get("signature_required") === "on";
  const replay_protection = formData.get("replay_protection") === "on";

  const { data, error } = await supabaseWriteClient()
    .from("integration_command_contracts")
    .insert({ company_id: p.companyId, connector_id, command_type, schema_ref, signature_required, replay_protection })
    .select("id")
    .maybeSingle();
  if (error) return;
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "integration_command_contract.created",
    entityType: "integration_command_contract",
    entityId: data?.id ?? null,
    payload: { command_type, connector_id },
  });
  revalidatePath("/app/admin/integrations");
}
