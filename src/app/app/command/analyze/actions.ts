"use server";

import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { createHash, randomUUID } from "node:crypto";
import { runManagerObservation } from "@/ai/manager-observation";
import { planFromObservation } from "@/management/ai-manager/pipeline";
import { makeSupabaseCostLedger } from "@/db/consumer-store";
import { buildManagementCase } from "@/management/ai-manager/case";
import { caseRow } from "@/management/ai-manager/case-store";
import { routeCapturedTasks, type RoutingSummary } from "@/management/routing/route-captured-tasks";
import { manualIdentity, taskIdentityParts } from "@/management/ai-manager/task-identity";
import { log } from "@/lib/log";

export interface AnalyzeState {
  error?: string;
  result?: {
    confirmedFacts: string[];
    inferredFacts: string[];
    createdTasks: number;
    /** AIM-002: proposed tasks that already existed under the same identity and were NOT recreated. */
    deduplicatedTasks: number;
    needsApproval: boolean;
    /** What actually happened to the captured tasks. Rendered instead of a claim. */
    routing: RoutingSummary;
    requiredAuthority: string;
    clarifications: string[];
    suggestedActions: string[];
    confidence: number;
  };
}

/**
 * Analyze a business update with the business analysis assistant. The AI observes and proposes;
 * it only ever creates low-risk `captured` tasks and flags sensitive matters for human
 * approval. It never executes an action, moves money, or makes a commitment (§6).
 */
export async function analyzeUpdate(_prev: AnalyzeState, formData: FormData): Promise<AnalyzeState> {
  const admin = await requireAdmin();
  const update = String(formData.get("update") ?? "").trim();
  if (!update) return { error: "Enter a business update to analyse." };
  if (!process.env.OPENAI_API_KEY) return { error: "AI gateway not configured (set OPENAI_API_KEY in the environment)." };

  const correlationId = `cor_${randomUUID().slice(0, 8)}`;
  let obsResult;
  try {
    // §WP5.2 — record cost/tokens/latency of manual manager analysis to the ledger.
    obsResult = await runManagerObservation(
      makeOpenAiTransport(),
      { update, companyId: admin.companyId, sourceEventId: "manual", correlationId },
      makeSupabaseCostLedger(supabaseAdmin()),
    );
  } catch (e) {
    return { error: `AI unavailable: ${(e as Error).message}` };
  }
  if (!obsResult.ok) return { error: `Could not analyse: ${obsResult.reason}` };

  const plan = planFromObservation(obsResult.observation);
  const db = supabaseAdmin();

  // §WP5.1 + completion P1B — ONE atomic, idempotent boundary persists the management case, its
  // captured tasks (low-risk only; the RPC forces status), and the audit event. A durability failure
  // is a HARD failure surfaced to the operator — never log-and-continue. The idempotency identity is
  // the submitted CONTENT (company + update text), not a constant: resubmitting the same update
  // returns the original case with zero duplicate tasks.
  const mc = buildManagementCase({
    correlationId,
    companyId: admin.companyId,
    sourceEventId: "manual",
    observation: obsResult.observation,
    proposals: [],
    aiRun: {
      ai_run_id: obsResult.run.ai_run_id,
      model: obsResult.run.model,
      prompt_version: obsResult.run.prompt_version,
      cost_usd: obsResult.run.cost_usd,
      latency_ms: obsResult.run.latency_ms,
    },
  });
  const contentKey = createHash("sha256").update(`${admin.companyId}\n${update}`).digest("hex");
  const idemKey = `manual:${contentKey}`;
  const identity = manualIdentity(contentKey);
  const { data: persisted, error: persistErr } = await db.rpc("create_management_case_atomic", {
    p_company: admin.companyId,
    p_idempotency_key: idemKey,
    p_case: { ...caseRow(mc, { createdBy: admin.userId, createdTasks: 0, requiresHuman: plan.needsApproval }) },
    // AIM-002 — every task this path creates now goes through create_task_deduplicated. Identity is
    // scoped to the SUBMITTED CONTENT: a free-text update names no stable entity, so two different
    // updates must never merge on their titles alone.
    p_tasks: plan.tasks.slice(0, 20).map((t) => ({
      title: t.title,
      note: t.note,
      requires_evidence: t.requiresEvidence,
      ...(taskIdentityParts(t.title, identity) ?? {}),
    })),
    p_actor: admin.userId,
    p_audit_action: "manager.analyzed",
  });
  if (persistErr || !persisted) {
    log("error", "management case persistence failed", { event: "case.persist_failed", correlationId, companyId: admin.companyId, error: persistErr?.message ?? "no result" });
    return { error: "Analysis could not be recorded durably — nothing was saved. Try again." };
  }
  const created = Number((persisted as { created_tasks?: number }).created_tasks ?? 0);
  const deduplicated = Number((persisted as { deduplicated_tasks?: number }).deduplicated_tasks ?? 0);
  const caseId = String((persisted as { case_id?: string }).case_id ?? "");

  // AIM-003: give every captured task a DURABLE routing row. The UI reports what actually happened
  // — it no longer says "routed for human approval" when nothing was routed.
  const routing = await routeCapturedTasks(
    {
      async listCaseTasks(companyId, managementCaseId) {
        const { data, error } = await db
          .from("tasks")
          .select("id, title")
          .eq("company_id", companyId)
          .eq("management_case_id", managementCaseId);
        if (error) throw new Error(error.message);
        return (data ?? []) as { id: string; title: string | null }[];
      },
      async routeTask(i) {
        const { data, error } = await db.rpc("route_task", {
          p_company: i.companyId,
          p_task: i.taskId,
          p_desired_state: i.state,
          p_reason_code: i.reasonCode,
          p_actor: i.actorId,
          p_actor_source: i.actorSource,
        });
        if (error) throw new Error(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        return { state: String(row?.routing_state ?? i.state), reasonCode: String(row?.reason_code ?? i.reasonCode) };
      },
    },
    { companyId: admin.companyId, managementCaseId: caseId, needsApproval: plan.needsApproval, actorId: admin.userId },
  );

  return {
    result: {
      routing,
      confirmedFacts: obsResult.observation.confirmedFacts ?? [],
      inferredFacts: obsResult.observation.inferredFacts ?? [],
      createdTasks: created,
      deduplicatedTasks: deduplicated,
      needsApproval: plan.needsApproval,
      requiredAuthority: plan.requiredAuthority,
      clarifications: plan.clarifications,
      suggestedActions: plan.suggestedActions,
      confidence: plan.confidence,
    },
  };
}
