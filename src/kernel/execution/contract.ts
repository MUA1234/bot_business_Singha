/**
 * R2E — the execution contract.
 *
 * One reusable approval-to-execution mechanism. It accepts ONLY catalogue-registered actions, and
 * it separates recommendation, draft, approval and execution into four distinct moments so that
 * authority and evidence can be revalidated at the LAST of them rather than assumed from the first.
 *
 * ── Why the outcome is a discriminated union and never a thrown/ignored error ────────────────
 *
 * R2E-F-002 recorded what the alternative costs: `createTask` returns normally when its insert
 * fails, so a caller cannot distinguish "created" from "silently did nothing". An executor built
 * on that shape would write a successful execution record for a task that does not exist. Every
 * path here therefore terminates in exactly one `ExecutionOutcome`, and `executed` is the only
 * variant that asserts a business effect occurred.
 *
 * ── The default is non-execution ─────────────────────────────────────────────────────────────
 *
 * Refusal is not an error state. It is the expected result: `draft_only` is the classification of
 * 13 of the 15 registered actions, and a refusal carries a closed `RefusalReason` so that "we chose
 * not to" is never confused with "we tried and it broke".
 */
import type { AuthorityLevel } from "@/schemas/management";
import type { CatalogueActionId } from "../catalogue";
import type { CompanyId, UserId } from "../ask-ai/identity";

/**
 * What R2E may do with an action, decided per action and never inferred.
 *
 * `locally_executable` does NOT mean "runs unattended". It means the action is allowlisted as
 * low-risk, internal and reversible, so that IF every other condition holds — both boundaries, an
 * exact policy, current authority, a live approval, current evidence and a durable idempotency
 * key — a real effect may be produced. Unattended operation is a separate switch that is off.
 */
export type ExecutionClassification =
  /** Never executed by R2E under any configuration. */
  | "prohibited"
  /** A human may be shown a draft; R2E produces no business effect. */
  | "draft_only"
  /** Allowlisted for a real effect, subject to every condition in `ExecutionConditions`. */
  | "locally_executable";

/** Handlers that actually exist. A policy may not name one that does not. */
export type ExecutionHandlerKey = "ops.task.create_internal.v1";

/**
 * The policy for ONE action. Every field is explicit.
 *
 * `authorityFloor` is stated here rather than read from the catalogue because the catalogue's own
 * floor proved not to be what the running system enforces (R2E-F-001). Stating it separately makes
 * the two comparable, and a test asserts this floor is never BELOW the catalogue's.
 */
export interface ActionExecutionPolicy {
  readonly classification: ExecutionClassification;
  readonly authorityFloor: AuthorityLevel;
  /** Whether a recorded human approval is required before execution. */
  readonly requiresApproval: boolean;
  /** The handler key, or `null` when no handler exists. Non-null ONLY for `locally_executable`. */
  readonly handler: ExecutionHandlerKey | null;
  /** Why this classification — carried into the ledger so a refusal is explicable later. */
  readonly rationale: string;
}

/**
 * Every reason execution may not proceed. CLOSED: an unlisted cause cannot be represented, so a
 * new refusal path cannot quietly reuse a neighbouring reason.
 *
 * Ordered by the stage that raises it, because the ledger records the FIRST refusal and the order
 * is itself a safety property: the boundaries are checked before anything is loaded, so a disabled
 * system reveals nothing about the item it was asked about.
 */
export type RefusalReason =
  // ── Boundaries, checked first and independently ──
  | "global_boundary_disabled"
  | "company_not_enabled"
  // ── The action itself ──
  | "action_not_registered"
  | "action_not_internal_only"
  | "no_execution_policy"
  | "classification_prohibited"
  | "classification_draft_only"
  | "no_handler"
  // ── Authority and approval, revalidated at execution time ──
  | "authority_insufficient"
  | "authority_failed_closed"
  | "approval_missing"
  | "approval_superseded"
  | "approver_lacks_capability"
  // ── The world, revalidated at execution time ──
  | "evidence_missing"
  | "evidence_stale"
  | "item_state_invalid"
  | "stale_state"
  | "parameters_invalid"
  // ── Durability ──
  | "idempotency_key_missing"
  | "ledger_unavailable";

/**
 * A request to execute one approved action.
 *
 * A typed object, not positional parameters. TD-001 and the `loadReconcile(companyId, source)`
 * swap are the reason: two same-typed strings in a row are a defect the compiler cannot see.
 * `companyId` and `actorId` are branded, so a user id cannot be passed where a company id belongs.
 *
 * There is NO idempotency key here. It is derived inside the trusted boundary from server-held
 * values (R2E-F-005): a key the caller chooses is a key the caller can vary to execute the same
 * approved decision twice, or reuse to collapse two different decisions into one.
 */
export interface ExecutionRequest {
  readonly companyId: CompanyId;
  /** The management item whose approved recommendation this is. */
  readonly itemId: string;
  readonly actionId: CatalogueActionId;
  /**
   * The human on whose approval this runs, or `null` for an action the canonical policy resolves
   * to `automatic`. Never a system principal dressed as a person.
   */
  readonly approvedBy: UserId | null;
  /**
   * Structured parameters for the handler. Never free text from a model, and never trusted: they
   * are validated against a STRICT per-action schema inside the boundary (R2E-F-007).
   */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requestedAt: Date;
}

/** The conditions that must ALL hold. Recorded so a refusal names which one failed. */
export interface ExecutionConditions {
  readonly globalBoundary: boolean;
  readonly companyEnabled: boolean;
  readonly actionRegistered: boolean;
  readonly policyAllows: boolean;
  readonly authoritySufficient: boolean;
  readonly approvalCurrent: boolean;
  readonly evidenceCurrent: boolean;
  readonly idempotencyDurable: boolean;
}

/**
 * The result. Exactly one of these, always.
 *
 * `executed` and `duplicate` are the only variants that imply a business effect exists — and
 * `duplicate` implies it was created by an EARLIER attempt, not this one.
 */
export type ExecutionOutcome =
  | {
      readonly status: "executed";
      readonly ledgerId: string;
      readonly handler: ExecutionHandlerKey;
      /** Identifier of the row the handler created or changed. */
      readonly effectRef: string;
    }
  | {
      readonly status: "duplicate";
      readonly ledgerId: string;
      /** The effect the FIRST attempt produced. Returned unchanged; nothing new happened. */
      readonly effectRef: string;
    }
  | {
      readonly status: "refused";
      readonly reason: RefusalReason;
      /** Non-sensitive. Never contains a cursor, a token, a customer name or a row's contents. */
      readonly detail: string;
    }
  | {
      readonly status: "failed";
      /** The handler was reached and did not succeed. No business effect is asserted. */
      readonly ledgerId: string | null;
      readonly error: string;
    };

/** Convenience constructors, so a refusal cannot be built with the wrong shape. */
export const refuse = (reason: RefusalReason, detail: string): ExecutionOutcome => ({
  status: "refused",
  reason,
  detail,
});

/** True only when a real business effect exists as a result of THIS attempt. */
export function producedEffect(o: ExecutionOutcome): boolean {
  return o.status === "executed";
}
