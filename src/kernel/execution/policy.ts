/**
 * R2E — the execution policy. ONE exact, typed, exhaustive table keyed by canonical action id.
 *
 * ── Why this exists, and why it is shaped this way ───────────────────────────────────────────
 *
 * R2E-F-001 found that the authority engine's `ACTION_FLOORS` and the catalogue were written in
 * different vocabularies, so every catalogue action was UNKNOWN to the engine. That failed safe
 * but invisibly: one string added to `ACTION_FLOORS` would have switched on unattended execution
 * for five actions with no test failing.
 *
 * The owner's direction is explicit about how that must NOT be repaired: no fuzzy matching, no
 * prefix matching, no normalised aliases, no fallback tiers, and no single mapping that
 * accidentally covers several actions. Each of those shares one property — an action can acquire
 * an authority it was never individually granted, because it resembles another one.
 *
 * So this table is a `Record<CatalogueActionId, …>`. The key type is the literal union derived from
 * `ACTION_CATALOGUE` itself. There is no lookup by pattern, no `startsWith`, no default branch and
 * no second list to keep in step:
 *
 *   * a catalogue action with no entry here does not COMPILE;
 *   * an entry here for an action not in the catalogue does not COMPILE;
 *   * an id that is not a catalogue id cannot be passed to `policyFor` at all;
 *   * an unknown id arriving at runtime as a bare string returns `null` — fail closed.
 *
 * ── The classifications ──────────────────────────────────────────────────────────────────────
 *
 * `draft_only` is the default and the majority. It is not a placeholder for "handler not written
 * yet": 13 of these actions have no handler and R2E does not invent one, because a handler written
 * to complete a table is a business effect nobody specified.
 */
import type {
  ActionExecutionPolicy,
  ExecutionClassification,
  ExecutionHandlerKey,
} from "./contract";
import { ACTION_CATALOGUE, type CatalogueActionId } from "../catalogue";

/**
 * The complete policy. Exhaustive by construction.
 *
 * Every floor here is at or above the catalogue's own `authorityFloor` — asserted by
 * `tests/kernel/execution-policy.test.ts`, which also pins the classification of all 15 so that
 * promoting ANY action to `locally_executable` fails a dedicated expected-policy test.
 */
const EXECUTION_POLICY: Record<CatalogueActionId, ActionExecutionPolicy> = {
  // ── The single allowlisted action ──────────────────────────────────────────────────────────
  //
  // Internal, reversible, and the one catalogue action whose effect already exists in the product.
  // It creates a task row in the requesting company. It does NOT assign a person: assignment is a
  // separate authority and is refused here by construction (the handler has no assignee parameter).
  "ops.task.create_internal": {
    classification: "locally_executable",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: "ops.task.create_internal.v1",
    rationale:
      "internal, reversible, company-scoped task creation with a durable idempotency key; " +
      "creates unassigned work only — assignment requires separate authority",
  },

  // ── No handler exists. R2E proposes a draft for a human and produces no effect. ────────────
  "ops.task.reminder_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists; a reminder is a message to a person and is drafted, not sent",
  },
  "ops.task.request_progress_update": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists; addressed to a person, so it is drafted for a human to send",
  },
  "ops.task.escalate_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale:
      "no handler exists; escalation changes who is accountable, which is a routing decision " +
      "a person makes",
  },
  "finance.invoice.flag_for_review": {
    classification: "draft_only",
    authorityFloor: "specialist_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists; finance domain floor applies regardless of the flag being internal",
  },
  "crm.followup.draft_for_human": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "drafting for a human IS the action; there is nothing for an executor to do",
  },
  "workforce.capacity.review_allocation": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists; allocation is a people decision",
  },
  "governance.directive.chase_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists; chasing is a message to a person",
  },
  "objectives.objective.review_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists",
  },
  "marketing.campaign.review_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists",
  },
  "procurement.stock.review_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists",
  },
  "assets.document.schedule_renewal_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists; a renewal date is a commitment a person makes",
  },
  "providers.provider.review_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale: "no handler exists; touches an external relationship even when the review is internal",
  },
  "system.health.investigate_internal": {
    classification: "draft_only",
    authorityFloor: "manager_approval",
    requiresApproval: true,
    handler: null,
    rationale:
      "no handler exists; catalogue-registered as automatic, but the engine has never resolved it " +
      "so — see R2E-F-001; it stays draft_only until Batch 6 proves the complete authority path",
  },

  // ── Never executed by R2E ──────────────────────────────────────────────────────────────────
  "legal.obligation.escalate_internal": {
    classification: "prohibited",
    authorityFloor: "specialist_approval",
    requiresApproval: true,
    handler: null,
    rationale:
      "a legal obligation escalation is a legal position; it is prohibited to R2E under every " +
      "configuration, not merely unimplemented",
  },
};

/**
 * The policy for an action, or `null` when there is none.
 *
 * Takes a bare `string` DELIBERATELY. A caller holding a `CatalogueActionId` is already safe; the
 * dangerous caller is the one holding a value that came from a row, a request body or a model, and
 * that caller must reach a fail-closed `null` rather than a lookup that nearly matches.
 *
 * `Object.hasOwn` rather than a bare index read: a prototype key such as `constructor` or
 * `toString` would otherwise return a truthy non-policy object.
 */
export function policyFor(actionId: string): ActionExecutionPolicy | null {
  if (!Object.hasOwn(EXECUTION_POLICY, actionId)) return null;
  return EXECUTION_POLICY[actionId as CatalogueActionId] ?? null;
}

/** The classification, fail-closed. An unknown action is `prohibited`, never a default tier. */
export function classificationFor(actionId: string): ExecutionClassification {
  return policyFor(actionId)?.classification ?? "prohibited";
}

/** The handler key, or null. Never non-null for an action that is not `locally_executable`. */
export function handlerFor(actionId: string): ExecutionHandlerKey | null {
  const p = policyFor(actionId);
  if (!p || p.classification !== "locally_executable") return null;
  return p.handler;
}

/**
 * The table is exhaustive by its key type, so a miss is impossible — but `noUncheckedIndexedAccess`
 * is on and a silent `undefined` here would become a silent `draft_only` downstream. Throw instead.
 */
function policyOrThrow(id: CatalogueActionId): ActionExecutionPolicy {
  const p = EXECUTION_POLICY[id];
  if (!p) throw new Error(`no execution policy for catalogue action "${id}"`);
  return p;
}

/** Read-only view, for tests and for the operator UI. */
export function allPolicies(): ReadonlyArray<readonly [CatalogueActionId, ActionExecutionPolicy]> {
  return ACTION_CATALOGUE.map((a) => [a.id, policyOrThrow(a.id)] as const);
}

/**
 * The actions R2E may ever produce an effect for. Currently exactly one.
 *
 * Derived from the table, not restated, so it cannot disagree with it.
 */
export function locallyExecutableActions(): CatalogueActionId[] {
  return ACTION_CATALOGUE.filter(
    (a) => policyOrThrow(a.id).classification === "locally_executable",
  ).map((a) => a.id);
}
