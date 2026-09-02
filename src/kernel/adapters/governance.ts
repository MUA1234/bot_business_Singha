/**
 * Governance observation adapter — owner/CEO command and decision management (R2A).
 *
 * WRAPS the existing, tested `evaluateDirectiveEscalation`
 * (src/modules/governance/directive-escalation.ts). The rule for when a directive is overdue
 * or escalating is not reimplemented here and not second-guessed.
 *
 * A directive is an OWNER INSTRUCTION. The kernel may notice that one is unanswered; it may
 * never answer, close, reissue or escalate it on the owner's behalf — so the authority class
 * is `manager_approval` and the action category is only ever a chase or a review.
 *
 * The directive's BODY is never copied into a management item: it is the owner's words about
 * the business, often sensitive, and the item carries the row reference instead.
 */
import { evaluateDirectiveEscalation, type EscalatableDirective } from "@/modules/governance/directive-escalation";
import type { EvidenceRef } from "../types";
import {
  dayWindow, freshnessFor, identityKeyFor, priorityFor,
  type Observation, type Severity,
} from "../observation";

export const GOVERNANCE_SOURCE = "governance.directive_overdue";

export interface DirectiveRow extends EscalatableDirective {
  id: string;
  updatedAt: string | null;
}

/** A directive in one of these states needs no chasing. */
const RESOLVED = new Set(["closed", "acknowledged"]);

export interface GovernanceScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  directives: DirectiveRow[];
}

export function detectGovernanceObservations(input: GovernanceScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const out: Observation[] = [];

  for (const d of input.directives) {
    // RESOLVED directives do not reappear as new work.
    if (RESOLVED.has(d.status)) continue;

    // Returns null when the directive is terminal, still within its window, or already
    // overdue with the chain exhausted. Null means nothing for the kernel to notice.
    const decision = evaluateDirectiveEscalation(d, now);
    if (!decision) continue;

    const severity: Severity = decision.newStatus === "escalated" ? "critical" : "warn";
    const freshness = freshnessFor(d.updatedAt, now);

    const evidence: EvidenceRef[] = [
      {
        sourceTable: "management_directives",
        sourceId: d.id,
        // Status and the escalation reason only. NEVER the directive body.
        facts: { directive_status: d.status, escalation_reason: decision.escalation_reason },
        origin: "detector",
      },
    ];

    out.push({
      companyId,
      department: "governance",
      observationSource: GOVERNANCE_SOURCE,
      kind: "directive_overdue",
      subjectRef: { table: "management_directives", id: d.id },
      evidence,
      evidenceAt: d.updatedAt ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts: { directive_status: d.status, escalation_reason: decision.escalation_reason },
      summary: "Owner directive awaiting a response",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId, observationSource: GOVERNANCE_SOURCE, subjectId: d.id, window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: severity === "critical" ? "escalate" : "chase",
      // Never automatic: an unanswered owner instruction is a management matter.
      authorityClass: "manager_approval",
      correlationId,
      // The response-due date is a real deadline, and it comes from the record.
      businessDeadline: d.response_required_by ? { at: d.response_required_by, source: "evidence" } : null,
    });
  }

  return out;
}
