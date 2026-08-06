/**
 * Durable management-case assembly (NEXT_PHASE_DEVELOPER_BRIEF §WP5.1).
 *
 * A "management case" is the persistent record of one material AI analysis: its
 * evidence, confirmed vs inferred facts, uncertainties, proposed actions with their
 * policy decisions, approvals and outcome — all tied together by a correlation id and
 * the source event. This module PURELY assembles that record from a validated
 * observation + routed proposals; the persistence layer writes it. Keeping confirmed
 * facts, inferred facts, uncertainty, evidence and confidence separate is a
 * Constitution requirement (never blur what is known vs guessed).
 */
import type { ManagementObservation } from "@/schemas/management";
import type { DecisionProposal } from "@/schemas/management";
import type { RouteResult } from "@/management/policy/route-decision";

export interface CaseProposal {
  proposal: DecisionProposal;
  routing: RouteResult;
}

export interface AiRunRef {
  ai_run_id: string;
  model: string;
  prompt_version: string;
  cost_usd: string;
  latency_ms?: number;
}

export interface ManagementCaseInput {
  correlationId: string;
  companyId: string;
  sourceEventId: string;
  observation: ManagementObservation;
  proposals: CaseProposal[];
  aiRun?: AiRunRef;
  now?: string; // ISO
}

export interface ManagementCase {
  correlationId: string;
  companyId: string;
  sourceEventId: string;
  createdAt: string;
  evidenceRefs: string[];
  confirmedFacts: string[];
  inferredFacts: string[];
  uncertainty: string | null;
  missingInfo: string[];
  confidence: number;
  requiredAuthority: string;
  aiRun: AiRunRef | null;
  decisions: Array<{
    action: string;
    routing: RouteResult["routing"];
    requiredLevel: RouteResult["requiredLevel"];
    requiredApprovers: string[];
    reasons: string[];
    status: "proposed";
  }>;
  /** True if any decision needs a human before anything can happen. */
  requiresHuman: boolean;
}

/**
 * Assemble a durable, evidence-linked case. Company scope + source event come from
 * TRUSTED input, never the model. Nothing here executes — decisions start "proposed".
 */
export function buildManagementCase(input: ManagementCaseInput): ManagementCase {
  const o = input.observation;
  const decisions = input.proposals.map((p) => ({
    action: p.proposal.action,
    routing: p.routing.routing,
    requiredLevel: p.routing.requiredLevel,
    requiredApprovers: p.routing.requiredApprovers,
    reasons: p.routing.reasons,
    status: "proposed" as const,
  }));

  return {
    correlationId: input.correlationId,
    companyId: input.companyId, // trusted, not from the model
    sourceEventId: input.sourceEventId,
    createdAt: input.now ?? new Date().toISOString(),
    evidenceRefs: o.evidenceRefs,
    confirmedFacts: o.confirmedFacts,
    inferredFacts: o.inferredFacts,
    uncertainty: o.uncertainty ?? null,
    missingInfo: o.missingInfo,
    confidence: o.confidence,
    requiredAuthority: o.requiredAuthority,
    aiRun: input.aiRun ?? null,
    decisions,
    requiresHuman: decisions.some((d) => d.routing === "require_approval"),
  };
}
