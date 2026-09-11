/**
 * R2E — the approval-to-execution engine.
 *
 * One mechanism, used by every action. It is easier to describe by what it refuses than by what it
 * does, because refusing is what it mostly does: 13 of the 15 registered actions are `draft_only`,
 * one is `prohibited`, and the remaining one still needs every condition below to hold.
 *
 * ── The owner's ten conditions, in the order they are checked ────────────────────────────────
 *
 *   1. the compile-time/server execution boundary is enabled
 *   2. the SEPARATE company execution setting is enabled
 *   3. the canonical action policy marks this exact action eligible
 *      (registered → internal-only → exact policy → classification → handler exists)
 *   7. parameters pass the strict typed schema          ← before any authority work
 *   5. authority is revalidated at execution time
 *   6. required approval is present, unless the exact policy genuinely resolves to automatic
 *   4. the management item and evidence GENERATION are current
 *   8. the task is internal and initially unassigned    ← enforced by the schema and the RPC
 *   9. the atomic idempotent RPC and the durable ledger
 *  10. no sensitive, financial, customer-facing, external or access-changing effect is implied
 *      ← enforced by the catalogue's `internalOnly` and by the policy admitting one action
 *
 * Nothing is written until step 2 passes. A globally disabled system therefore performs no query
 * about the company it was asked about, and reveals nothing — including whether that company
 * exists. That is what makes "disabled" provable by inspecting the database rather than by
 * trusting this file.
 *
 * ── Why authority is resolved again here ─────────────────────────────────────────────────────
 *
 * Approval and execution are different moments. Between them a person can lose a capability, a
 * delegation can lapse, a policy can change, and the evidence can stop being true. A recommendation
 * carries the authority that was required WHEN IT WAS MADE; using that at execution time would be
 * enforcing a permission that may since have been revoked.
 *
 * ── Why the idempotency identity is derived, not accepted (R2E-F-005) ────────────────────────
 *
 * A caller who chooses the key can vary it to execute one approved decision twice, or reuse it to
 * collapse two decisions into one. The identity is therefore computed from server-held values —
 * company, item, decision version, canonical action id and the hash of the VALIDATED parameters —
 * after the approval and item have been loaded, so it reflects the state that was actually checked.
 *
 * ── Why a crash cannot duplicate an effect ───────────────────────────────────────────────────
 *
 * The ledger row is claimed BEFORE the handler runs, under a unique `(company_id,
 * idempotency_key)` index. The handler is itself idempotent under the same key. So a crash between
 * the two leaves an `attempting` row, and the retry resumes it: the handler is re-invoked, returns
 * the effect the first attempt already created, and the row resolves. The effect happens once
 * because the DATABASE arbitrates the key, not because this code is careful — this code is the
 * part that crashes.
 */
import type { CatalogueActionId } from "../catalogue";
import { ACTION_CATALOGUE } from "../catalogue";
import type { CompanyId, UserId } from "../ask-ai/identity";
import type { AuthorityLevel } from "@/schemas/management";
import {
  refuse,
  type ExecutionHandlerKey,
  type ExecutionOutcome,
  type ExecutionRequest,
  type RefusalReason,
} from "./contract";
import { checkExecutionBoundaries } from "./boundary";
import { policyFor, EXECUTION_POLICY_VERSION } from "./policy";
import { resolveCanonicalAuthority, type CanonicalAuthority } from "./authority";
import { deriveIdempotencyKey, validateParameters } from "./parameters";

/** What the approval record must show at execution time. */
export interface ApprovalSnapshot {
  readonly approvedBy: UserId;
  readonly actionId: string;
  /** The authority the approver exercised. */
  readonly authority: AuthorityLevel;
  /** False when a later decision replaced this one. */
  readonly current: boolean;
  /** Identifies this decision. Changes when the decision is superseded. */
  readonly decisionVersion: string;
  /** The evidence generation the approval was granted AGAINST. */
  readonly evidenceGeneration: string;
  /** The company the approval belongs to — checked against the request's own company. */
  readonly companyId: CompanyId;
}

/**
 * The RECORDED PLAN — what the system proposed, under which rules, against which condition.
 *
 * Every field here was written server-side when the advice was recorded. None of it comes from the
 * caller, and none of it is about a candidate: eligibility evidence belongs to assignment, and
 * comparing it here is exactly the defect R2F-F-017 was.
 */
export interface RecommendationPlan {
  /** The CONDITION evidence digest at the time the advice was given. */
  readonly conditionEvidenceDigest: string;
  /** The canonical action the advice was for. */
  readonly actionId: string;
  /** Digest of the planned parameters, re-derived from the stored plan rather than trusted. */
  readonly parameterDigest: string;
  /** The policy table's identity at the time. */
  readonly policyVersion: string;
  /** Identifies this recommendation, for the durable execution identity. */
  readonly version: string;
}

/** What the item must still look like. */
export interface ItemSnapshot {
  readonly state: string;
  readonly evidenceCount: number;
  readonly actionId: string;
  /** The CONDITION evidence generation NOW — `management_item_evidence`, nothing else. */
  readonly evidenceGeneration: string;
  /**
   * The plan the item currently stands on, or null when none was recorded.
   *
   * Null is fail-closed for an automatic action: without a recorded plan there is nothing the
   * execution was authorised against, so there is nothing to be fresh with respect to.
   */
  readonly plan: RecommendationPlan | null;
  readonly companyId: CompanyId;
}

export interface ClaimResult {
  readonly ledgerId: string;
  /** `fresh` = we own it. `resuming` = an earlier attempt crashed. Otherwise terminal already. */
  readonly kind: "fresh" | "resuming" | "executed" | "refused" | "failed";
  readonly effectRef: string | null;
}

export interface LedgerPort {
  /** Claim `(company, key)`. The unique index arbitrates; this must not pre-check and then insert. */
  claim(row: {
    companyId: CompanyId;
    itemId: string;
    actionId: CatalogueActionId;
    idempotencyKey: string;
    approvedBy: UserId | null;
    resolvedAuthority: AuthorityLevel;
    handler: ExecutionHandlerKey;
  }): Promise<ClaimResult>;

  resolveExecuted(ledgerId: string, effectRef: string): Promise<void>;
  resolveFailed(ledgerId: string, error: string): Promise<void>;

  /**
   * Record a refusal that happened AFTER both boundaries passed.
   *
   * Under its own key, never the caller's: a refusal must not consume an idempotency identity, or a
   * request refused today for a missing approval could never be executed tomorrow once the approval
   * exists.
   */
  recordRefusal(row: {
    companyId: CompanyId;
    itemId: string;
    actionId: CatalogueActionId;
    idempotencyKey: string;
    reason: RefusalReason;
    detail: string;
  }): Promise<void>;
}

export type ExecutionHandler = (
  req: ExecutionRequest & {
    /** The VALIDATED parameters. A handler never sees the raw bag. */
    readonly validatedParameters: Record<string, unknown>;
    readonly idempotencyKey: string;
  },
) => Promise<{ effectRef: string; created: boolean }>;

export interface ExecutorDeps {
  /** Present ONLY in a deterministic local test. No server path can supply it. */
  readonly localToken?: string;
  companyExecutionEnabled(companyId: CompanyId): Promise<boolean>;
  /**
   * Resolved NOW. Defaults to the canonical resolver; injectable so a test can drive an authority
   * the canonical policy would not produce, which is how "authority revoked at execution time" is
   * exercised at all.
   */
  resolveAuthorityNow?(req: ExecutionRequest): Promise<CanonicalAuthority>;
  loadApproval(req: ExecutionRequest): Promise<ApprovalSnapshot | null>;
  loadItem(req: ExecutionRequest): Promise<ItemSnapshot | null>;
  /** The approver's capabilities AS THEY ARE NOW, not as they were at approval. */
  approverCapabilities(req: ExecutionRequest): Promise<ReadonlySet<string>>;
  readonly ledger: LedgerPort;
  readonly handlers: Readonly<Partial<Record<ExecutionHandlerKey, ExecutionHandler>>>;
  /**
   * Claim, produce the effect, and write the terminal ledger result — in ONE transaction.
   *
   * The default path below does those as three round trips: `ledger.claim`, then the handler,
   * then `ledger.resolveExecuted`. Nothing spans them, so a crash between the second and third
   * leaves a task that exists with no ledger row saying so — and the next retry, finding no
   * terminal row, creates a SECOND task for the same customer. That is the worst failure this
   * module can produce, and it is unreachable from a client that speaks PostgREST anyway, which
   * is why `executionSql` was undefined in every server path (R2F-F-019).
   *
   * When a deployment supplies this, the executor uses it INSTEAD of that sequence. Every check
   * above still runs here first — classification, both boundaries, authority, capability,
   * freshness, parameter validation — and the transport re-checks all of them again inside the
   * transaction, because a check performed by the caller is a courtesy and a check performed in
   * the transaction is a control.
   */
  atomicExecute?(req: {
    companyId: CompanyId;
    itemId: string;
    actionId: CatalogueActionId;
    idempotencyKey: string;
    handler: ExecutionHandlerKey;
    validatedParameters: Readonly<Record<string, unknown>>;
    conditionEvidenceDigest: string;
    eligibilityDigest: string | null;
    parameterDigest: string;
    policyVersion: string;
  }): Promise<
    | { kind: "executed"; ledgerId: string; effectRef: string; created: boolean }
    | { kind: "refused"; reason: RefusalReason; detail: string }
    /**
     * Some OTHER terminal outcome already exists under this execution identity — an earlier
     * refusal or failure. Distinct from `refused`, which describes THIS attempt and stays
     * retryable once the condition clears. This one is a prior verdict, and it is reported as
     * `failed` exactly as the sequential path reports the same situation.
     */
    | { kind: "terminal"; ledgerId: string; status: string }
  >;
  /** Fail-closed. Must throw if the event could not be recorded. */
  audit(entry: {
    companyId: CompanyId;
    actorId: UserId | null;
    action: string;
    entityId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

const LADDER: AuthorityLevel[] = [
  "automatic",
  "policy_controlled",
  "manager_approval",
  "specialist_approval",
  "owner_approval",
];
const rank = (l: AuthorityLevel) => LADDER.indexOf(l);

/** States from which an approved action may still be executed. */
const EXECUTABLE_ITEM_STATES = new Set(["approved", "assigned"]);

/**
 * Execute one approved action, or — far more often — refuse and say exactly why.
 *
 * Never throws for an expected condition. A throw here means the ledger or the audit sink was
 * unreachable, which is not a refusal and must not be recorded as one.
 */
export async function executeApprovedAction(
  deps: ExecutorDeps,
  req: ExecutionRequest,
): Promise<ExecutionOutcome> {
  // ── 1 & 2. Both boundaries. Nothing is written before these pass. ──
  const boundary = await checkExecutionBoundaries({
    companyId: req.companyId,
    localToken: deps.localToken,
    companyExecutionEnabled: deps.companyExecutionEnabled,
  });
  if (!boundary.ok) return refuse(boundary.reason, boundary.detail);

  // ── 3. The action is registered, internal-only, and has an exact eligible policy. ──
  const entry = ACTION_CATALOGUE.find((a) => a.id === req.actionId);
  if (!entry) return refuse("action_not_registered", "action is not in the catalogue");
  if (entry.internalOnly !== true) {
    return refuse("action_not_internal_only", "action is not internal-only");
  }

  const policy = policyFor(req.actionId);
  if (!policy) {
    return refuse("no_execution_policy", "no execution policy is registered for this action");
  }
  if (policy.classification === "prohibited") {
    return refuse("classification_prohibited", "this action is prohibited to the executor");
  }
  if (policy.classification === "draft_only") {
    return refuse("classification_draft_only", "this action is draft-only; a person must act");
  }

  const handlerKey = policy.handler;
  if (!handlerKey) return refuse("no_handler", "the policy names no handler");
  const handler = deps.handlers[handlerKey];
  if (!handler) return refuse("no_handler", `handler "${handlerKey}" is not registered`);

  const refusePost = async (
    reason: RefusalReason,
    detail: string,
    key = "pre-identity",
  ): Promise<ExecutionOutcome> => {
    await deps.ledger.recordRefusal({
      companyId: req.companyId,
      itemId: req.itemId,
      actionId: req.actionId,
      idempotencyKey: key,
      reason,
      detail,
    });
    return refuse(reason, detail);
  };

  // ── 7. Parameters, against a STRICT per-action schema, before any authority work. ──
  const params = validateParameters(req.actionId, req.parameters);
  if (!params.ok) return refusePost("parameters_invalid", params.message);

  // ── 5. Authority, resolved NOW, canonically. ──
  const resolveAuthority = deps.resolveAuthorityNow
    ? deps.resolveAuthorityNow
    : async (r: ExecutionRequest) => resolveCanonicalAuthority(r.actionId);
  const authority = await resolveAuthority(req);

  if (authority.failedClosed) {
    return refusePost(
      "authority_failed_closed",
      "the authority engine could not resolve this action and escalated",
    );
  }
  if (rank(authority.level) > rank(policy.authorityFloor)) {
    return refusePost(
      "authority_insufficient",
      `requires ${authority.level}; policy floor is ${policy.authorityFloor}`,
    );
  }

  // ── 6. Approval, unless the policy GENUINELY resolves to automatic. ──
  //
  // "Genuinely" is doing work: `authority.automatic` is true only when the canonical policy floor,
  // the exact owner-authorised action id, the catalogue's `automaticSafe`, `reversible` and
  // `internalOnly` flags, and the `locally_executable` classification ALL agree.
  const mayRunWithoutApproval = authority.automatic && !policy.requiresApproval;

  let approval: ApprovalSnapshot | null = null;
  if (!mayRunWithoutApproval) {
    approval = await deps.loadApproval(req);
    if (!approval) return refusePost("approval_missing", "no approval is recorded for this action");
    if (approval.companyId !== req.companyId) {
      // A cross-company approval is not a stale approval; it is someone else's decision.
      return refusePost("approval_missing", "the approval belongs to a different company");
    }
    if (!approval.current) {
      return refusePost("approval_superseded", "the approval was replaced by a later decision");
    }
    if (approval.actionId !== req.actionId) {
      return refusePost("approval_missing", "the approval is for a different action");
    }
    if (req.approvedBy === null || approval.approvedBy !== req.approvedBy) {
      return refusePost("approval_missing", "the approval names a different approver");
    }
    if (rank(approval.authority) < rank(authority.level)) {
      return refusePost(
        "authority_insufficient",
        "the approval was given at a lower authority than is now required",
      );
    }
    // Capabilities are re-read, because approval and execution are different moments and a
    // capability can be revoked between them.
    const caps = await deps.approverCapabilities(req);
    if (entry.capability && !caps.has(entry.capability)) {
      return refusePost(
        "approver_lacks_capability",
        "the approver no longer holds the capability this action requires",
      );
    }
  }

  // ── 4. The item and the evidence GENERATION. ──
  const item = await deps.loadItem(req);
  if (!item) return refusePost("item_state_invalid", "the management item no longer exists");
  if (item.companyId !== req.companyId) {
    return refusePost("item_state_invalid", "the item belongs to a different company");
  }
  if (item.actionId !== req.actionId) {
    return refusePost("stale_state", "the item now proposes a different action");
  }
  if (!EXECUTABLE_ITEM_STATES.has(item.state)) {
    return refusePost("item_state_invalid", `item state "${item.state}" does not admit execution`);
  }
  if (item.evidenceCount < 1) {
    return refusePost("evidence_missing", "the item no longer holds any evidence");
  }

  // ── 8. Freshness, each set against its OWN kind (R2F-F-017). ──
  //
  // R2E-F-006 established why a count is not enough: an approval given against three overdue
  // invoices must not execute after those three are paid and replaced by three unrelated ones —
  // the count is still 3 and the state is still `approved`.
  //
  // What this used to do, on the automatic branch, was compare the item's CONDITION evidence
  // against the recommendation's CANDIDATE-ELIGIBILITY evidence: the business facts that raised
  // the item against the facts that make a person a plausible assignee. Two different record sets
  // about two different subjects, compared for equality — so no item the real cycle created could
  // ever execute. The eligibility set is checked at ASSIGNMENT, where it means something.
  const plan = item.plan;
  if (!approval && !plan) {
    // An automatic action with no recorded plan was authorised against nothing.
    return refusePost("evidence_stale", "no recommendation plan is recorded for this item");
  }

  const decidedAgainst = approval ? approval.evidenceGeneration : plan!.conditionEvidenceDigest;
  if (decidedAgainst !== item.evidenceGeneration) {
    return refusePost(
      "evidence_stale",
      "the condition evidence has changed since the decision was made",
    );
  }

  if (plan) {
    if (plan.actionId !== req.actionId) {
      return refusePost("stale_state", "the recommendation was for a different action");
    }
    if (plan.policyVersion !== EXECUTION_POLICY_VERSION) {
      return refusePost(
        "policy_version_changed",
        "the execution policy changed after this was recommended",
      );
    }
    if (plan.parameterDigest !== params.hash) {
      // The caller is asking for something other than what was planned. Not an invalid request —
      // a DIFFERENT one, which has to be recommended and approved on its own terms.
      return refusePost(
        "parameters_stale",
        "the parameters differ from the recorded plan",
      );
    }
  }

  // ── 9. The durable identity, DERIVED from what was just checked. ──
  const idempotencyKey = deriveIdempotencyKey({
    companyId: req.companyId,
    itemId: req.itemId,
    actionId: req.actionId,
    // The recommendation's own identity for an automatic action, never a digest of somebody's
    // eligibility. A new recommendation is a new authorisation and must not collide with the old.
    decisionVersion: approval ? approval.decisionVersion : (plan?.version ?? "no-plan"),
    evidenceGeneration: item.evidenceGeneration,
    parameterHash: params.hash,
  });

  // ── The atomic path, when the deployment has one ──────────────────────────────────────
  //
  // Placed here rather than earlier so that EVERY check above has already run: this replaces
  // the claim/effect/ledger sequence, not the decisions that authorise it.
  if (deps.atomicExecute) {
    let outcome: Awaited<ReturnType<NonNullable<ExecutorDeps["atomicExecute"]>>>;
    try {
      outcome = await deps.atomicExecute({
        companyId: req.companyId,
        itemId: req.itemId,
        actionId: req.actionId,
        idempotencyKey,
        handler: handlerKey,
        validatedParameters: params.value,
        conditionEvidenceDigest: item.evidenceGeneration,
        // The recommendation's OWN identity, not a digest of somebody's eligibility. Two record
        // sets about two different subjects (R2F-F-017), so they travel separately.
        eligibilityDigest: plan?.version ?? null,
        parameterDigest: plan?.parameterDigest ?? "no-parameters",
        policyVersion: plan?.policyVersion ?? "",
      });
    } catch (e) {
      // A transport we cannot reach is a transport that cannot prevent a duplicate. The claim
      // and the effect are one statement, so a throw here means NEITHER happened.
      return refuse("ledger_unavailable", (e as Error).message);
    }

    if (outcome.kind === "refused") {
      // The transport refused after its own re-check. It wrote nothing and consumed no
      // idempotency key, so this stays retryable once the condition clears.
      return refuse(outcome.reason, outcome.detail);
    }
    if (outcome.kind === "terminal") {
      // Word for word the sequential path's answer to the same situation, because it IS the
      // same situation: returning the existing verdict rather than starting a second attempt is
      // what stops a retry loop from producing a second effect.
      return {
        status: "failed",
        ledgerId: outcome.ledgerId,
        error: `a previous attempt under this execution identity is terminal (${outcome.status})`,
      };
    }
    // ── Past this point the effect EXISTS and the ledger says so, in ONE committed transaction.
    //
    // The audit event is written with the same fail-closed handling as the sequential path below,
    // and for the same reason: an executed effect that produced no audit record must be reported
    // as a failure to record it, never as nothing having happened. Omitting it here would have made
    // the two transports observably different in the one place a reader most needs them to agree.
    try {
      await deps.audit({
        companyId: req.companyId,
        actorId: approval ? approval.approvedBy : null,
        action: "management.execution.executed",
        entityId: outcome.effectRef,
        payload: {
          actionId: req.actionId,
          itemId: req.itemId,
          handler: handlerKey,
          resolvedAuthority: authority.level,
          automatic: mayRunWithoutApproval,
          // No `resumed`: there is no claim to resume. The transaction either produced the effect
          // or found the idempotency key already spent.
          resumed: false,
          newEffect: outcome.created,
        },
      });
    } catch (e) {
      return {
        status: "failed",
        ledgerId: outcome.ledgerId,
        error:
          `effect ${outcome.effectRef} was created and recorded, but the audit event failed: ` +
          (e as Error).message,
      };
    }

    // Split rather than a ternary on `status`: the two outcomes are different shapes, and the
    // executed one carries the handler that produced the effect.
    return outcome.created
      ? { status: "executed" as const, ledgerId: outcome.ledgerId, handler: handlerKey, effectRef: outcome.effectRef }
      : { status: "duplicate" as const, ledgerId: outcome.ledgerId, effectRef: outcome.effectRef };
  }

  let claim: ClaimResult;
  try {
    claim = await deps.ledger.claim({
      companyId: req.companyId,
      itemId: req.itemId,
      actionId: req.actionId,
      idempotencyKey,
      approvedBy: approval ? approval.approvedBy : null,
      resolvedAuthority: authority.level,
      handler: handlerKey,
    });
  } catch (e) {
    // A ledger we cannot write to is a ledger that cannot prevent a duplicate. Do not proceed.
    return refuse("ledger_unavailable", (e as Error).message);
  }

  if (claim.kind === "executed") {
    return { status: "duplicate", ledgerId: claim.ledgerId, effectRef: claim.effectRef ?? "" };
  }
  if (claim.kind === "refused" || claim.kind === "failed") {
    // A terminal outcome already exists under this identity. Returning it — rather than starting a
    // second attempt — is what stops a retry loop from producing a second effect.
    return {
      status: "failed",
      ledgerId: claim.ledgerId,
      error: `a previous attempt under this execution identity is terminal (${claim.kind})`,
    };
  }

  // `fresh` or `resuming`. Resuming re-invokes the handler, which is idempotent under the same
  // key and returns the effect the crashed attempt already created.
  let effect: { effectRef: string; created: boolean };
  try {
    effect = await handler({ ...req, validatedParameters: params.value, idempotencyKey });
    await deps.ledger.resolveExecuted(claim.ledgerId, effect.effectRef);
  } catch (e) {
    const message = (e as Error).message;
    try {
      await deps.ledger.resolveFailed(claim.ledgerId, message);
    } catch {
      // The ledger is unreachable. The outcome below still reports failure, which is the
      // conservative claim: no business effect is asserted.
    }
    return { status: "failed", ledgerId: claim.ledgerId, error: message };
  }

  // ── Past this point the effect EXISTS and the ledger says so. ──
  //
  // A failure here is not "nothing happened", and must never be reported as though it were. The
  // ledger row is already terminal, so `resolveFailed` would be refused by the append-only guard
  // anyway — attempting it would replace a truthful record with an error about writing one.
  try {
    await deps.audit({
      companyId: req.companyId,
      actorId: approval ? approval.approvedBy : null,
      action: "management.execution.executed",
      entityId: effect.effectRef,
      payload: {
        actionId: req.actionId,
        itemId: req.itemId,
        handler: handlerKey,
        resolvedAuthority: authority.level,
        automatic: mayRunWithoutApproval,
        resumed: claim.kind === "resuming",
        // `created:false` means the handler found the effect already there.
        newEffect: effect.created,
      },
    });
  } catch (e) {
    return {
      status: "failed",
      ledgerId: claim.ledgerId,
      error:
        `effect ${effect.effectRef} was created and recorded, but the audit event failed: ` +
        (e as Error).message,
    };
  }

  return claim.kind === "resuming" && !effect.created
    ? { status: "duplicate", ledgerId: claim.ledgerId, effectRef: effect.effectRef }
    : {
        status: "executed",
        ledgerId: claim.ledgerId,
        handler: handlerKey,
        effectRef: effect.effectRef,
      };
}
