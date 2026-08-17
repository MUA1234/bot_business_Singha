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
import { log } from "@/lib/log";

export interface AnalyzeState {
  error?: string;
  result?: {
    confirmedFacts: string[];
    inferredFacts: string[];
    createdTasks: number;
    needsApproval: boolean;
    requiredAuthority: string;
    clarifications: string[];
    suggestedActions: string[];
    confidence: number;
  };
}

/**
 * Analyze a business update with the Senior AI Manager. The AI observes and proposes;
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
  const idemKey = `manual:${createHash("sha256").update(`${admin.companyId}\n${update}`).digest("hex")}`;
  const { data: persisted, error: persistErr } = await db.rpc("create_management_case_atomic", {
    p_company: admin.companyId,
    p_idempotency_key: idemKey,
    p_case: { ...caseRow(mc, { createdBy: admin.userId, createdTasks: 0, requiresHuman: plan.needsApproval }) },
    p_tasks: plan.tasks.slice(0, 20).map((t) => ({ title: t.title, note: t.note, requires_evidence: t.requiresEvidence })),
    p_actor: admin.userId,
    p_audit_action: "manager.analyzed",
  });
  if (persistErr || !persisted) {
    log("error", "management case persistence failed", { event: "case.persist_failed", correlationId, companyId: admin.companyId, error: persistErr?.message ?? "no result" });
    return { error: "Analysis could not be recorded durably — nothing was saved. Try again." };
  }
  const created = Number((persisted as { created_tasks?: number }).created_tasks ?? 0);

  return {
    result: {
      confirmedFacts: obsResult.observation.confirmedFacts ?? [],
      inferredFacts: obsResult.observation.inferredFacts ?? [],
      createdTasks: created,
      needsApproval: plan.needsApproval,
      requiredAuthority: plan.requiredAuthority,
      clarifications: plan.clarifications,
      suggestedActions: plan.suggestedActions,
      confidence: plan.confidence,
    },
  };
}
