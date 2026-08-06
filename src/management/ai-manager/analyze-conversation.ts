/**
 * Shared Senior-AI-Manager analysis of a WhatsApp conversation (§WP5.1/5.2). Used by
 * BOTH the manual "Analyse with AI" action and the continuous monitoring cron, so the
 * pipeline is identical: fence untrusted text → observe (through the cost ledger) →
 * plan → capture low-risk tasks → persist a durable, correlation-tied management case.
 *
 * Observe/propose only — it never replies to the customer, moves money, or executes.
 * Company scope + source event are trusted inputs, never taken from the model.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { runManagerObservation } from "@/ai/manager-observation";
import { planFromObservation } from "@/management/ai-manager/pipeline";
import { buildManagementCase } from "@/management/ai-manager/case";
import { persistManagementCase } from "@/management/ai-manager/case-store";
import { makeSupabaseCostLedger } from "@/db/consumer-store";

export interface AnalyzeResult {
  ok: boolean;
  reason?: string;
  createdTasks?: number;
  needsApproval?: boolean;
}

/**
 * Analyse one conversation thread. `db` is a service-role client (worker path).
 * Returns a summary; persists the case + captured tasks. Safe to call repeatedly —
 * it only reads + inserts low-risk `captured` tasks and a case record.
 */
export async function analyzeConversationThread(
  db: SupabaseClient,
  opts: { companyId: string; conversationId: string; actorId: string; actorType?: "user" | "ai" },
): Promise<AnalyzeResult> {
  const { data: messages } = await db
    .from("wa_messages")
    .select("direction, body, created_at")
    .eq("conversation_id", opts.conversationId)
    .eq("company_id", opts.companyId)
    .order("created_at", { ascending: true })
    .limit(200);

  const text = (messages ?? [])
    .filter((m: { body?: string }) => m.body)
    .map((m: { direction: string; body: string }) => `${m.direction === "inbound" ? "Customer" : "Us"}: ${m.body}`)
    .join("\n");
  if (!text.trim()) return { ok: false, reason: "empty" };

  const correlationId = `cor_${randomUUID().slice(0, 8)}`;
  const res = await runManagerObservation(
    makeOpenAiTransport(),
    { update: text, companyId: opts.companyId, sourceEventId: `wa:${opts.conversationId}`, correlationId },
    makeSupabaseCostLedger(db),
  );
  if (!res.ok) return { ok: false, reason: res.reason };

  const plan = planFromObservation(res.observation);
  let created = 0;
  for (const t of plan.tasks.slice(0, 20)) {
    const { error } = await db.from("tasks").insert({
      company_id: opts.companyId,
      title: t.title,
      description: t.note,
      status: "captured",
      requires_evidence: t.requiresEvidence,
      created_by: opts.actorId,
    });
    if (!error) created++;
  }

  const mc = buildManagementCase({
    correlationId,
    companyId: opts.companyId,
    sourceEventId: `wa:${opts.conversationId}`,
    observation: res.observation,
    proposals: [],
    aiRun: { ai_run_id: res.run.ai_run_id, model: res.run.model, prompt_version: res.run.prompt_version, cost_usd: res.run.cost_usd, latency_ms: res.run.latency_ms },
  });
  await persistManagementCase(db, mc, { createdBy: opts.actorId, createdTasks: created, requiresHuman: plan.needsApproval });

  return { ok: true, createdTasks: created, needsApproval: plan.needsApproval };
}
