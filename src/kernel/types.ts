/**
 * Management kernel contracts (R1 — KRN-002, KRN-003).
 *
 * Types only. The kernel is domain-agnostic: nothing here names an invoice, a vehicle or a
 * conversation. A department participates by registering an ObservationSource and a set of
 * DomainActions — never by adding a branch to the kernel.
 */

export type Department = "finance" | "workforce" | "operations" | "crm" | "system";
export const DEPARTMENTS: readonly Department[] = ["finance", "workforce", "operations", "crm", "system"] as const;

export type Priority = "critical" | "high" | "normal" | "low";
export type ResourceType = "staff" | "bot" | "external";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * A reference to a real row, plus the structured facts a detector read from it.
 *
 * `facts` is STRUCTURED and DETERMINISTIC. A detector states "47 days overdue, 480000 LKR,
 * 3 prior reminders". It never states "this looks bad" — interpretation belongs to the
 * kernel, and keeping it there is what stops five departmental intelligences re-emerging.
 */
export interface EvidenceRef {
  sourceTable: string;
  sourceId: string;
  facts: Record<string, JsonValue>;
  /** A model may CITE evidence; it may never CREATE it. Hence no "model" origin. */
  origin?: "detector" | "human";
}

/** What a detector emits. It never creates a case, calls a model, or decides authority. */
export interface Observation {
  companyId: string;
  department: Department;
  kind: string;
  subjectRef: { table: string; id: string };
  evidence: EvidenceRef[];
  facts: Record<string, JsonValue>;
  detectedAt: string;
  /** company + kind + subject + occurrence window (AIM-002 deduplication). */
  identityKey: string;
  /**
   * A real-world deadline, ONLY when one exists in the source evidence or company policy
   * (owner decision R1-D-4). A detector must never invent one; `null` is the honest answer.
   */
  businessDeadline?: { at: string; source: "evidence" | "policy" } | null;
}

/**
 * How an observation source can be triggered (owner decision R1-D-5).
 *
 * One contract, four modes. `event` is preferred wherever an event already exists — it
 * means no polling at all. `scheduled` is a reconciliation sweep driven by the EXISTING
 * in-process scheduler; R1 introduces no second scheduler and no uncontrolled polling.
 */
export type TriggerMode = "event" | "scheduled" | "manual" | "test";

export interface ObservationSourceSpec {
  department: Department;
  kind: string;
  supportsEvent: boolean;
  supportsScheduled: boolean;
  supportsManual: boolean;
  /** Required when `supportsScheduled`. Configurable per source and per company. */
  cadenceSeconds?: number | null;
}

export interface ScanContext {
  companyId: string;
  trigger: TriggerMode;
  now: Date;
}

export interface ObservationSource {
  readonly spec: ObservationSourceSpec;
  scan(ctx: ScanContext): Promise<Observation[]>;
}

/**
 * A scan outcome. A detector that throws must NOT be reported as "no problems found":
 * the department is recorded UNOBSERVED and the surface says so, rather than giving an
 * all-clear it cannot justify.
 */
export type ScanResult =
  | { ok: true; department: Department; kind: string; observations: Observation[] }
  | { ok: false; department: Department; kind: string; reason: string; unobserved: true };

/**
 * A registered action (KRN-003). The kernel may only ever SELECT from the catalogue and
 * fill a validated schema — it can never invent an action, which is what keeps free-text
 * model output away from business state.
 */
export interface DomainAction {
  id: string;
  department: Department;
  capability: string | null;
  authorityFloor: "automatic" | "policy_controlled" | "manager_approval" | "specialist_approval" | "owner_approval";
  reversible: boolean;
  /** True only for internal, low-risk, reversible actions permitted unattended under D-9. */
  automaticSafe: boolean;
  /** R1: no action may send a customer message, move money, post a journal or call out. */
  internalOnly: true;
  description: string;
}

/** Deadlines, kept strictly separate (owner decision R1-D-4). */
export interface ItemDeadlines {
  /** The real-world deadline. Null unless evidence or policy supplied one. */
  businessDeadline: string | null;
  businessDeadlineSource: "evidence" | "policy" | null;
  /** When management should look again. Null when no review policy is configured. */
  reviewBy: string | null;
  reviewPolicyId: string | null;
}

/**
 * Display state for a review time. R1-D-4 forbids fabricating one, so the honest answer
 * when nothing is configured is to say exactly that.
 */
export function reviewTimingLabel(d: Pick<ItemDeadlines, "reviewBy" | "reviewPolicyId">): string {
  if (!d.reviewPolicyId) return "review timing not configured";
  return d.reviewBy ?? "review timing not configured";
}

/** Why no assignee could be recommended (owner decision R1-D-3). */
export interface RoutingRequest {
  department: Department;
  reason: string;
  requestedAt: string;
  /** Set once, so a queued item does not re-notify on every sweep. */
  notifiedAt?: string | null;
}

export type InterpretationStatus =
  | "ok"
  | "malformed"
  | "timeout"
  | "low_confidence"
  | "disagreement"
  | "unavailable";

/**
 * The result of the one step that may consult a model.
 *
 * R1 runs the deterministic fixture adapter only (owner decision R1-D-6): no paid or live
 * model calls during R0–R3. The adapter boundary exists so a future model connects at
 * exactly one place, and the failure modes are recorded now rather than discovered later.
 */
export interface Interpretation {
  source: "none" | "fixture" | "model";
  status: InterpretationStatus;
  /** Structured statements the interpreter drew from the evidence. Never free-text actions. */
  statements: Array<{ claim: string; supportedBy: Array<{ sourceTable: string; sourceId: string }> }>;
  confidence: number;
  note?: string;
}
