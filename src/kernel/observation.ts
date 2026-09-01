/**
 * The common observation contract (R1 checkpoint 3 — KRN-002).
 *
 * Every departmental adapter produces THIS shape and nothing else. The kernel never learns
 * what an invoice or a vehicle is; it learns that something in a department needs attention,
 * which evidence supports that, and how confident and urgent the detector was.
 *
 * Two rules make this safe to store, and both are enforced here rather than trusted:
 *
 *   MINIMUM SAFE SUMMARY. An observation carries structured, non-identifying FACTS plus
 *   REFERENCES to the rows they came from. It must not copy customer names, message bodies,
 *   bank details, salaries or any other payload into the management item — the item is read
 *   by managers across a company, while the source row is protected by its own RLS. Anyone
 *   wanting the detail follows the reference and is authorised at that point.
 *
 *   COMPANY IDENTITY IS RESOLVED, NEVER ACCEPTED. `companyId` may only come from an
 *   authorised source (the scan context the kernel supplies). An adapter that reads a
 *   company id out of a payload row is refused.
 */
import type { Department, EvidenceRef, JsonValue, Priority } from "./types";

export type Severity = "critical" | "warn" | "info";

/** How fresh the underlying source record is at detection time. */
export type Freshness = "fresh" | "aging" | "stale" | "unknown";

/**
 * The CATEGORY of action suggested — never the action itself, and never free text.
 * The kernel maps a category to registered catalogue actions; the detector proposes a kind
 * of response and has no power to choose or perform one.
 */
export type ActionCategory =
  | "review"
  | "chase"
  | "reassign"
  | "escalate"
  | "schedule"
  | "investigate"
  | "none";

/** The authority a response is EXPECTED to need. Advisory; the authority engine decides. */
export type AuthorityClass =
  | "automatic"
  | "policy_controlled"
  | "manager_approval"
  | "specialist_approval"
  | "owner_approval";

export interface Observation {
  /** Resolved by the kernel from the scan context — never read from a payload row. */
  companyId: string;
  department: Department;
  /** Which registered source produced this, e.g. "finance.receivable_overdue". */
  observationSource: string;
  /** The specific condition detected, e.g. "receivable_overdue". */
  kind: string;

  /** The source record this is about. */
  subjectRef: { table: string; id: string };
  /** References to the rows that justify it. Never copied prose. */
  evidence: EvidenceRef[];
  /** When the underlying evidence was last true / last written. */
  evidenceAt: string;
  /** When the detector ran. */
  detectedAt: string;

  /** Structured, minimal, non-identifying. */
  facts: Record<string, JsonValue>;
  /** One short, non-identifying line for a human queue. */
  summary: string;

  severity: Severity;
  priority: Priority;
  /** Detector confidence in [0,1]. Deterministic detectors are 1. */
  confidence: number;

  /** company + source + subject + occurrence window. Stable across re-scans. */
  identityKey: string;
  freshness: Freshness;

  suggestedActionCategory: ActionCategory;
  authorityClass: AuthorityClass;

  /** Ties every item, transition and audit row of one scan together. */
  correlationId: string;

  /**
   * A real-world deadline, ONLY when the evidence or a company policy supplies one
   * (owner decision R1-D-4). Never invented; null is the honest answer.
   */
  businessDeadline?: { at: string; source: "evidence" | "policy" } | null;
}

export class ObservationRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ObservationRejected";
  }
}

/** Keys an adapter may never place in `facts`. Fails closed on the whole observation. */
const FORBIDDEN_FACT_KEYS = [
  "password", "secret", "token", "api_key", "apikey", "access_token", "service_role",
  "authorization", "connection_string", "dsn", "private_key", "credential",
  "account_number", "bank_account", "iban", "card_number", "cvv",
  "salary", "wage", "remuneration", "national_id", "nic", "passport",
  "email", "phone", "address", "full_name", "customer_name", "message_body", "body", "transcript",
];

const looksSensitive = (key: string): boolean => {
  const k = key.toLowerCase();
  return FORBIDDEN_FACT_KEYS.some((f) => k === f || k.includes(f));
};

/**
 * Validate an observation before it may become a management item.
 *
 * Every branch FAILS CLOSED: a rejected observation does not degrade into a partial item, it
 * does not silently drop a field, and it does not pass with a warning.
 */
export function assertObservationSafe(o: Observation, ctx: { companyId: string }): void {
  // COMPANY IDENTITY: resolved, never accepted.
  if (!o.companyId) throw new ObservationRejected("missing_company", "observation has no company identity");
  if (o.companyId !== ctx.companyId) {
    throw new ObservationRejected(
      "unresolved_company",
      `observation claims company ${o.companyId} but was scanned for ${ctx.companyId} — company identity may only come from the authorised scan context`,
    );
  }

  if (!o.subjectRef?.table?.trim() || !o.subjectRef?.id?.trim()) {
    throw new ObservationRejected("missing_subject", "observation must reference a source record");
  }
  if (!o.identityKey?.trim()) {
    throw new ObservationRejected("missing_identity_key", "observation must carry a deterministic identity key");
  }
  if (!o.correlationId?.trim()) {
    throw new ObservationRejected("missing_correlation", "observation must carry correlation information");
  }

  // MISSING EVIDENCE fails closed.
  if (!Array.isArray(o.evidence) || o.evidence.length === 0) {
    throw new ObservationRejected("missing_evidence", `observation ${o.identityKey} carries no evidence`);
  }
  for (const e of o.evidence) {
    if (!e.sourceTable?.trim() || !e.sourceId?.trim()) {
      throw new ObservationRejected("malformed_evidence", "evidence must name both a source table and a row id");
    }
  }

  if (typeof o.confidence !== "number" || Number.isNaN(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    throw new ObservationRejected("malformed_confidence", `confidence ${o.confidence} is outside [0,1]`);
  }

  // MINIMUM SAFE SUMMARY — no sensitive payload copied into the management item.
  for (const key of Object.keys(o.facts ?? {})) {
    if (looksSensitive(key)) {
      throw new ObservationRejected(
        "sensitive_fact",
        `fact "${key}" may not be copied into a management item — reference the source row instead`,
      );
    }
  }
  for (const e of o.evidence) {
    for (const key of Object.keys(e.facts ?? {})) {
      if (looksSensitive(key)) {
        throw new ObservationRejected(
          "sensitive_fact",
          `evidence fact "${key}" may not be copied into a management item — reference the source row instead`,
        );
      }
    }
  }

  // R1-D-4: a deadline must state a legitimate provenance or not exist.
  if (o.businessDeadline) {
    const { at, source } = o.businessDeadline;
    if (!at || (source !== "evidence" && source !== "policy")) {
      throw new ObservationRejected("invented_deadline", `observation ${o.identityKey} carries an unsourced deadline`);
    }
  }
}

/**
 * The deterministic identity key.
 *
 * Same company, source, subject and occurrence window ⇒ same key ⇒ the SAME management item
 * is reused rather than a duplicate created. Changing the window is what allows a genuinely
 * new occurrence of a recurring condition to become new work.
 */
export function identityKeyFor(parts: {
  companyId: string;
  observationSource: string;
  subjectId: string;
  window: string;
}): string {
  return [parts.companyId, parts.observationSource, parts.subjectId, parts.window].join("|");
}

/** UTC day window — the default occurrence window for daily-cadence detectors. */
export const dayWindow = (d: Date): string => d.toISOString().slice(0, 10);

/** Freshness from the age of the evidence, in days. */
export function freshnessFor(evidenceAt: string | null, now: Date): Freshness {
  if (!evidenceAt) return "unknown";
  const t = Date.parse(evidenceAt);
  if (Number.isNaN(t)) return "unknown";
  const days = (now.getTime() - t) / 86_400_000;
  if (days < 0) return "unknown"; // future-dated evidence is not "fresh", it is suspect
  if (days <= 7) return "fresh";
  if (days <= 30) return "aging";
  return "stale";
}

/** Severity → queue priority. One mapping, so departments cannot disagree about urgency. */
export function priorityFor(severity: Severity, freshness: Freshness): Priority {
  if (severity === "critical") return "critical";
  if (severity === "warn") return freshness === "stale" ? "normal" : "high";
  return freshness === "stale" ? "low" : "normal";
}
