/**
 * Management-case row mapping (NEXT_PHASE_DEVELOPER_BRIEF §WP5.1). `caseRow` is the pure map from a
 * ManagementCase to its DB shape; PERSISTENCE now goes exclusively through the atomic, idempotent,
 * service-only `create_management_case_atomic` RPC (migration 0068) — the former log-and-continue
 * `persistManagementCase` helper was removed (completion P1B): a durability failure must fail the
 * analysis, and the case + its tasks + the audit event must commit in ONE transaction.
 */
import type { ManagementCase } from "@/management/ai-manager/case";

export interface CaseExtras {
  createdBy: string | null;
  createdTasks: number;
  /** Force human-required (e.g. the planner flagged approval) even if no structured
   *  proposal did. */
  requiresHuman?: boolean;
}

/** Pure map from a ManagementCase (+ extras) to the management_cases row. */
export function caseRow(c: ManagementCase, extra: CaseExtras): Record<string, unknown> {
  return {
    company_id: c.companyId,
    correlation_id: c.correlationId,
    source_event_id: c.sourceEventId,
    ai_run_id: c.aiRun?.ai_run_id ?? null,
    confirmed_facts: c.confirmedFacts,
    inferred_facts: c.inferredFacts,
    evidence_refs: c.evidenceRefs,
    uncertainty: c.uncertainty,
    missing_info: c.missingInfo,
    confidence: c.confidence,
    required_authority: c.requiredAuthority,
    decisions: c.decisions,
    requires_human: extra.requiresHuman || c.requiresHuman,
    created_tasks: extra.createdTasks,
    created_by: extra.createdBy,
  };
}
