"use server";

import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { runManagerObservation } from "@/ai/manager-observation";
import { planFromObservation } from "@/management/ai-manager/pipeline";
import { makeSupabaseCostLedger } from "@/db/consumer-store";
import { buildManagementCase } from "@/management/ai-manager/case";
import { persistManagementCase } from "@/management/ai-manager/case-store";

/**
 * Run the Senior AI Manager over a customer conversation: it observes the thread and
 * captures follow-up tasks. Observe/propose only — never executes, never replies to
 * the customer. Admin-only. UNTRUSTED conversation text is fenced inside the gateway.
 */
export async function analyzeConversation(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const conversationId = String(formData.get("conversation_id") ?? "");
  if (!conversationId) return;
  if (!p.isAdmin) redirect(`/app/messages/${conversationId}?err=forbidden`);
  if (!process.env.OPENAI_API_KEY) redirect(`/app/messages/${conversationId}?err=ai_off`);

  const db = supabaseAdmin();
  const { data: convo } = await db.from("wa_conversations").select("id, customer_name, customer_wa_id").eq("id", conversationId).eq("company_id", p.companyId).maybeSingle();
  if (!convo) redirect(`/app/messages/${conversationId}?err=not_found`);

  const { data: messages } = await db.from("wa_messages").select("direction, body, created_at").eq("conversation_id", conversationId).eq("company_id", p.companyId).order("created_at", { ascending: true }).limit(200);
  const text = (messages ?? [])
    .filter((m: any) => m.body)
    .map((m: any) => `${m.direction === "inbound" ? "Customer" : "Us"}: ${m.body}`)
    .join("\n");
  if (!text.trim()) redirect(`/app/messages/${conversationId}?captured=0`);

  let res;
  try {
    res = await runManagerObservation(
      makeOpenAiTransport(),
      { update: text, companyId: p.companyId, sourceEventId: `wa:${conversationId}` },
      makeSupabaseCostLedger(db),
    );
  } catch {
    redirect(`/app/messages/${conversationId}?err=ai_error`);
  }
  if (!res.ok) redirect(`/app/messages/${conversationId}?err=ai_error`);

  const plan = planFromObservation(res.observation);
  let created = 0;
  for (const t of plan.tasks.slice(0, 20)) {
    const { error } = await db.from("tasks").insert({
      company_id: p.companyId, title: t.title, description: t.note,
      status: "captured", requires_evidence: t.requiresEvidence, created_by: p.userId,
    });
    if (!error) created++;
  }
  // §WP5.1 — persist the durable case, tied to the same AI run via its correlation id.
  const mc = buildManagementCase({
    correlationId: res.run.correlation_id,
    companyId: p.companyId,
    sourceEventId: `wa:${conversationId}`,
    observation: res.observation,
    proposals: [],
    aiRun: { ai_run_id: res.run.ai_run_id, model: res.run.model, prompt_version: res.run.prompt_version, cost_usd: res.run.cost_usd, latency_ms: res.run.latency_ms },
  });
  await persistManagementCase(db, mc, { createdBy: p.userId, createdTasks: created, requiresHuman: plan.needsApproval });

  await writeAudit({ companyId: p.companyId, actorId: p.userId, actorType: "ai", action: "conversation.analyzed", entityType: "wa_conversation", entityId: conversationId, payload: { createdTasks: created } });
  redirect(`/app/messages/${conversationId}?captured=${created}`);
}
