/**
 * Persist a durable management case (NEXT_PHASE_DEVELOPER_BRIEF §WP5.1). The row
 * mapping is pure (`caseRow`, exported for testing); the insert is graceful — a
 * missing table (pre-0028) or error is logged, never thrown, so an AI analysis is
 * never brought down by a persistence gap.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagementCase } from "@/management/ai-manager/case";
import { log } from "@/lib/log";

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

export async function persistManagementCase(db: SupabaseClient, c: ManagementCase, extra: CaseExtras): Promise<void> {
  const { error } = await db.from("management_cases").insert(caseRow(c, extra));
  if (error) log("error", "management_cases insert failed", { event: "case.persist_failed", correlationId: c.correlationId, error: error.message });
}
