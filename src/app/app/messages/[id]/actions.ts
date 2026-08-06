"use server";

import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { analyzeConversationThread } from "@/management/ai-manager/analyze-conversation";

/**
 * Run the Senior AI Manager over a customer conversation: it observes the thread and
 * captures follow-up tasks. Observe/propose only — never executes, never replies to
 * the customer. Admin-only. Shares the exact pipeline with the continuous monitor cron
 * via `analyzeConversationThread` (fenced untrusted text → observe → plan → case).
 */
export async function analyzeConversation(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const conversationId = String(formData.get("conversation_id") ?? "");
  if (!conversationId) return;
  if (!p.isAdmin) redirect(`/app/messages/${conversationId}?err=forbidden`);
  if (!process.env.OPENAI_API_KEY) redirect(`/app/messages/${conversationId}?err=ai_off`);

  const db = supabaseAdmin();
  const { data: convo } = await db.from("wa_conversations").select("id").eq("id", conversationId).eq("company_id", p.companyId).maybeSingle();
  if (!convo) redirect(`/app/messages/${conversationId}?err=not_found`);

  let res;
  try {
    res = await analyzeConversationThread(db, { companyId: p.companyId, conversationId, actorId: p.userId });
  } catch {
    redirect(`/app/messages/${conversationId}?err=ai_error`);
  }
  if (!res.ok) redirect(`/app/messages/${conversationId}?err=${res.reason === "empty" ? "empty" : "ai_error"}`);

  await db.from("wa_conversations").update({ ai_analyzed_at: new Date().toISOString() }).eq("id", conversationId).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, actorType: "ai", action: "conversation.analyzed", entityType: "wa_conversation", entityId: conversationId, payload: { createdTasks: res.createdTasks } });
  redirect(`/app/messages/${conversationId}?captured=${res.createdTasks ?? 0}`);
}
