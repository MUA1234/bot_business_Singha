/**
 * Operations observation adapter (R1 checkpoint 3).
 *
 * WRAPS the existing, tested `detectTaskExceptions` (src/management/ai-manager/exceptions.ts).
 * The detection logic — what counts as overdue, blocked, stale or missing an estimate — is
 * not reimplemented here and not second-guessed.
 *
 * A DETECTOR MUST NOT PERFORM THE ACTION. This module never assigns, never reminds, never
 * escalates; it reports that a task needs attention and stops.
 */
import { detectTaskExceptions, type TaskLike, type Severity as ExSeverity } from "@/management/ai-manager/exceptions";
import { isTerminal, type TaskState } from "@/modules/work/task-lifecycle";
import type { EvidenceRef } from "../types";
import {
  dayWindow,
  STORED_STATE_FRESHNESS,
  identityKeyFor,
  priorityFor,
  type ActionCategory,
  type Observation,
  type Severity,
} from "../observation";

export const OPERATIONS_SOURCE = "operations.task_exception";

export interface TaskRow extends TaskLike {
  updatedAt: string | null;
}

const CATEGORY_BY_TYPE: Record<string, ActionCategory> = {
  overdue: "chase",
  due_soon: "review",
  blocked: "escalate",
  escalated: "escalate",
  stale_check_in: "chase",
  missing_estimate: "review",
};

export interface OperationsScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  tasks: TaskRow[];
}

export function detectOperationsObservations(input: OperationsScanInput): Observation[] {
  const { companyId, correlationId, now } = input;

  // RESOLVED work does not reappear. A completed or cancelled task is filtered BEFORE the
  // detector runs, so a finished task can never generate new management work.
  const live = input.tasks.filter((t) => !isTerminal(t.status as TaskState));
  const byId = new Map(live.map((t) => [t.id, t]));

  const exceptions = detectTaskExceptions(live, now);

  const out: Observation[] = [];
  for (const ex of exceptions) {
    const taskId = ex.taskId;
    if (!taskId) continue;
    const row = byId.get(taskId);
    if (!row) continue;

    const severity = mapSeverity(ex.severity);
    // Stored state, re-read in full this cycle: our information is current however long ago
    // the row was last edited. Anchoring on the record's age discarded the longest-neglected
    // conditions — the ones that most need raising (R2S-P-F-004).
    const freshness = STORED_STATE_FRESHNESS;

    const evidence: EvidenceRef[] = [
      {
        sourceTable: "tasks",
        sourceId: taskId,
        // Condition and state only — NOT the task title, which can carry customer or
        // personnel detail written by whoever created it.
        facts: { exception_type: ex.type, task_status: row.status },
        origin: "detector",
      },
    ];

    out.push({
      companyId,
      department: "operations",
      observationSource: OPERATIONS_SOURCE,
      kind: ex.type,
      subjectRef: { table: "tasks", id: taskId },
      evidence,
      evidenceAt: row.updatedAt ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts: { exception_type: ex.type, task_status: row.status },
      summary: `Task ${ex.type.replace(/_/g, " ")}`,
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId,
        observationSource: OPERATIONS_SOURCE,
        // The TYPE is part of the identity: an overdue task and a blocked task are two
        // different conditions on the same subject and deserve two items.
        subjectId: `${taskId}:${ex.type}`,
        window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: CATEGORY_BY_TYPE[ex.type] ?? "review",
      // Chasing or re-planning internal work is ordinary management activity.
      authorityClass: ex.type === "blocked" || ex.type === "escalated" ? "manager_approval" : "automatic",
      correlationId,
      // The task's own due date, and only when it has one (R1-D-4).
      businessDeadline: row.dueDate ? { at: row.dueDate, source: "evidence" } : null,
    });
  }

  return out;
}

const mapSeverity = (s: ExSeverity): Severity => (s === "critical" ? "critical" : s === "warn" ? "warn" : "info");
