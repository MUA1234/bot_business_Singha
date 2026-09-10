/**
 * Outcome verification by RE-OBSERVATION (roadmap R5, R2F-F-004).
 *
 * ── The three facts this exists to keep apart ────────────────────────────────────────────────
 *
 *   1. an action was EXECUTED          — a row was written
 *   2. work was CLAIMED complete       — somebody said so, or a task moved to a terminal status
 *   3. the original business CONDITION is verified resolved
 *
 * Creating an internal task proves (1). It proves nothing about (3). The overdue invoice that
 * caused the recommendation is still overdue until something reads it again and finds otherwise.
 *
 * ── What must never count as proof of resolution ─────────────────────────────────────────────
 *
 * An item vanishing from one page; a detector returning nothing during a partial cycle; a record
 * that could not be loaded; access revoked; a source that timed out; an execution that succeeded;
 * a task status that changed; a person clicking complete; a model saying it is fixed. Each of
 * those is a statement about the SYSTEM, and verification is a statement about the BUSINESS.
 *
 * `tasks.updated_at` is specifically excluded: a timestamp moves when anything about a row
 * changes, including edits that leave the condition exactly as it was.
 */
import type { Department } from "../types";

/**
 * What re-observation concluded. Six outcomes, and only the first is success.
 *
 * These sit alongside the lifecycle rather than replacing it: `verified_resolved` drives
 * `verifying → verified`, `condition_persists` and `condition_worsened` drive `verifying →
 * reopened`, and the remaining three drive no transition at all — the item stays where it is and
 * the reason is recorded.
 */
export type VerificationOutcome =
  /** Re-read, and the originating condition is genuinely gone. */
  | "verified_resolved"
  /** Re-read, and the condition is still there. */
  | "condition_persists"
  /** Re-read, and it is worse than when it was observed. */
  | "condition_worsened"
  /** Re-read, and the evidence contradicts the claim in a way the rule cannot reconcile. */
  | "contradicted"
  /** Could not look: the read failed, access was revoked, or the record's absence is ambiguous. */
  | "unavailable"
  /** Absence-based rules only — a clean generation covering this source has not completed yet. */
  | "pending_clean_observation";

/** Only one outcome may feed positive learning. */
export function feedsPositiveLearning(o: VerificationOutcome): boolean {
  return o === "verified_resolved";
}

/**
 * Outcomes that must never become a negative signal about a person.
 *
 * Approved leave, missing data, an unavailable source and a condition that simply persists are
 * facts about the world or about this system, not about whoever was assigned the work. Letting
 * them accumulate against a person is how a management tool becomes a surveillance tool.
 */
export function isNeutralForPeople(o: VerificationOutcome): boolean {
  return o === "unavailable" || o === "pending_clean_observation" || o === "condition_persists";
}

/** The item, as the verifier needs it. Loaded server-side; never supplied by a caller. */
export interface ItemUnderVerification {
  readonly id: string;
  readonly companyId: string;
  readonly department: Department;
  /** The exception kind the detector raised — the thing that must be gone. */
  readonly kind: string;
  /** The ORIGINATING observation identity. */
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly state: string;
  /** The evidence generation the item was recommended against. */
  readonly evidenceGeneration: string;
  /**
   * When completion was claimed — the transition into `verifying`, or the execution effect.
   * Verification must observe the world AFTER this moment, or it is observing the old world.
   */
  readonly claimedAt: Date;
}

/** The state of the sweep that produced the verification read. */
export interface SweepState {
  /** True only when the source was read to the end of its generation. */
  readonly complete: boolean;
  /** The generation the read belongs to. */
  readonly generation: string;
  /** True when the generation was reset, abandoned or truncated. */
  readonly interrupted: boolean;
  /** When this read happened. */
  readonly observedAt: Date;
}

/** A targeted re-read of the originating record. */
export type SourceRead<T> =
  | { readonly ok: true; readonly row: T | null }
  /** The read itself failed. NOT the same as "the row is not there". */
  | { readonly ok: false; readonly reason: string };

export interface VerificationResult {
  readonly outcome: VerificationOutcome;
  /** Non-sensitive. Never a row's contents, a customer name or a task title. */
  readonly detail: string;
  /** The lifecycle state this implies, or null when the item should not move. */
  readonly transitionTo: "verified" | "reopened" | null;
}

export const result = (
  outcome: VerificationOutcome,
  detail: string,
  transitionTo: VerificationResult["transitionTo"] = null,
): VerificationResult => ({ outcome, detail, transitionTo });
