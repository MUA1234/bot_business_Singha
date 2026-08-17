/**
 * Shared Senior-AI-Manager analysis of a WhatsApp conversation (§WP5.1/5.2). Used by
 * BOTH the manual "Analyse with AI" action and the continuous monitoring cron, so the
 * pipeline is identical: fence untrusted text → observe (through the cost ledger) →
 * plan → capture low-risk tasks → persist a durable, correlation-tied management case.
 *
 * Observe/propose only — it never replies to the customer, moves money, or executes.
 * Company scope + source event are trusted inputs, never taken from the model.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { runManagerObservation } from "@/ai/manager-observation";
import { planFromObservation } from "@/management/ai-manager/pipeline";
import { buildManagementCase } from "@/management/ai-manager/case";
import { caseRow } from "@/management/ai-manager/case-store";
import { makeSupabaseCostLedger } from "@/db/consumer-store";
import { log } from "@/lib/log";

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

  // Completion P1B — atomic + idempotent persistence: the case, its captured tasks and the audit
  // event commit together or not at all. The idempotency identity is the conversation PLUS the
  // analysed transcript content: re-running on an unchanged thread replays the original case (no
  // duplicate tasks); new messages produce a new identity and a new case. A durability failure is
  // a hard failure — never "analysed" without a durable record.
  const mc = buildManagementCase({
    correlationId,
    companyId: opts.companyId,
    sourceEventId: `wa:${opts.conversationId}`,
    observation: res.observation,
    proposals: [],
    aiRun: { ai_run_id: res.run.ai_run_id, model: res.run.model, prompt_version: res.run.prompt_version, cost_usd: res.run.cost_usd, latency_ms: res.run.latency_ms },
  });
  const idemKey = `wa:${opts.conversationId}:${createHash("sha256").update(text).digest("hex")}`;
  const { data: persisted, error: persistErr } = await db.rpc("create_management_case_atomic", {
    p_company: opts.companyId,
    p_idempotency_key: idemKey,
    p_case: { ...caseRow(mc, { createdBy: opts.actorId, createdTasks: 0, requiresHuman: plan.needsApproval }) },
    p_tasks: plan.tasks.slice(0, 20).map((t) => ({ title: t.title, note: t.note, requires_evidence: t.requiresEvidence })),
    p_actor: opts.actorId,
    p_audit_action: "manager.thread_analyzed",
  });
  if (persistErr || !persisted) {
    log("error", "management case persistence failed", { event: "case.persist_failed", correlationId, companyId: opts.companyId, error: persistErr?.message ?? "no result" });
    return { ok: false, reason: "persist_failed" };
  }
  const created = Number((persisted as { created_tasks?: number }).created_tasks ?? 0);

  return { ok: true, createdTasks: created, needsApproval: plan.needsApproval };
}
