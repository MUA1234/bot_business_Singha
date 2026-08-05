"use server";

import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { runManagerObservation } from "@/ai/manager-observation";
import { planFromObservation } from "@/management/ai-manager/pipeline";

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
    res = await runManagerObservation(makeOpenAiTransport(), { update: text, companyId: p.companyId, sourceEventId: `wa:${conversationId}` });
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
  await writeAudit({ companyId: p.companyId, actorId: p.userId, actorType: "ai", action: "conversation.analyzed", entityType: "wa_conversation", entityId: conversationId, payload: { createdTasks: created } });
  redirect(`/app/messages/${conversationId}?captured=${created}`);
}
