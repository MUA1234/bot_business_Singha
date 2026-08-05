"use server";

import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { runManagerObservation } from "@/ai/manager-observation";
import { planFromObservation } from "@/management/ai-manager/pipeline";

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

  let obsResult;
  try {
    obsResult = await runManagerObservation(makeOpenAiTransport(), { update, companyId: admin.companyId, sourceEventId: "manual" });
  } catch (e) {
    return { error: `AI unavailable: ${(e as Error).message}` };
  }
  if (!obsResult.ok) return { error: `Could not analyse: ${obsResult.reason}` };

  const plan = planFromObservation(obsResult.observation);
  const db = supabaseAdmin();

  // Create the detected tasks as `captured` (low-risk). Never anything sensitive.
  let created = 0;
  for (const t of plan.tasks.slice(0, 20)) {
    const { error } = await db.from("tasks").insert({
      company_id: admin.companyId,
      title: t.title,
      description: t.note,
      status: "captured",
      requires_evidence: t.requiresEvidence,
      created_by: admin.userId,
    });
    if (!error) created++;
  }

  await writeAudit({
    companyId: admin.companyId,
    actorId: admin.userId,
    actorType: "ai",
    action: "manager.analyzed",
    entityType: "management_observation",
    payload: { createdTasks: created, requiredAuthority: plan.requiredAuthority, confidence: plan.confidence },
  });

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
