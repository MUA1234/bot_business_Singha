/**
 * R2E — the server execution service. The ONLY runtime entrypoint (R2E-F-008).
 *
 * Before this, `executeApprovedAction` was imported by nothing outside `src/kernel/execution/`:
 * R2E had delivered a library, not a path the running system could take. Condition 1 speaks of a
 * server execution boundary, which presupposes a server surface for the boundary to guard.
 *
 * ── What this file is, and what it deliberately is not ───────────────────────────────────────
 *
 * It assembles the real dependencies from the real schema — the real management item, the real
 * decision, the real evidence, the real capability join, the real ledger and the real atomic RPC.
 * It does not accept any of them from a caller.
 *
 * It is NOT wired to an HTTP route. The global boundary is closed, so a route would be a surface
 * that can only ever return `global_boundary_disabled` — an execution endpoint that exists but
 * cannot execute is an invitation to someone later removing the check rather than the endpoint.
 * The operator UI reads execution STATE through its own read-only path; producing an effect has no
 * public surface at all while the boundary is shut.
 *
 * ── What a caller may say ────────────────────────────────────────────────────────────────────
 *
 * Company, item, action, and parameters. Nothing else. In particular the caller does not supply
 * authority, approval, approver identity, evidence generation, execution state or an idempotency
 * key: every one of those is read or derived server-side, inside the boundary. A caller who could
 * assert them could execute an unapproved action by asserting that it was approved.
 */
import { createHash } from "node:crypto";
import { digestOfPlannedParameters } from "./plan";
import type { CatalogueActionId } from "../catalogue";
import { asCompanyId, asUserId, type CompanyId, type UserId } from "../ask-ai/identity";
import type { ExecutionOutcome, ExecutionRequest } from "./contract";
import { refuse } from "./contract";
import { EXECUTION_GLOBALLY_ENABLED, LOCAL_EXECUTION_TOKEN } from "./boundary";
import {
  executeApprovedAction,
  type ApprovalSnapshot,
  type ExecutorDeps,
  type ItemSnapshot,
  type RecommendationPlan,
} from "./executor";
import { createSqlLedger, type SqlExec } from "./ledger";
import { idempotentRpcTransport, type RpcCapableClient } from "./transports";
import { createInternalTask } from "@/modules/work/create-internal-task";

/**
 * What the service needs from its environment.
 *
 * `sql` must be a SERVER-side connection. It is used for the ledger and for the loaders, which read
 * across a company's management state and therefore cannot run under an arbitrary end-user session.
 * Every query it issues is explicitly company-scoped by parameter, and each loader re-checks the
 * company on the row it read rather than trusting the filter it just wrote.
 */
export interface ExecutionEnvironment {
  readonly sql: SqlExec;
  readonly rpc: RpcCapableClient;
  /** Fail-closed audit. Must throw when the event cannot be recorded. */
  audit(entry: {
    companyId: CompanyId;
    actorId: UserId | null;
    action: string;
    entityId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void>;
  /** Present ONLY in a deterministic local test. No server path has anywhere to get it from. */
  readonly localToken?: string;
}

/** Everything a caller is permitted to say. */
export interface ExecutionServiceInput {
  readonly companyId: string;
  readonly itemId: string;
  readonly actionId: CatalogueActionId;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * A content digest of the evidence currently attached to an item.
 *
 * A COUNT cannot serve here: three overdue invoices replaced by three unrelated ones is still
 * three. The digest is over the ordered `(source_table, source_id)` pairs, so any substitution,
 * addition or removal changes it (R2E-F-006).
 */
async function evidenceGeneration(sql: SqlExec, companyId: string, itemId: string): Promise<string> {
  const { rows } = await sql(
    `select coalesce(
              md5(string_agg(source_table || ':' || source_id, '|'
                             order by source_table, source_id)),
              'empty') as digest,
            count(*)::int as n
       from management_item_evidence
      where company_id = $1 and item_id = $2`,
    [companyId, itemId],
  );
  return String(rows[0]?.digest ?? "empty");
}

/**
 * The PLAN the item currently stands on.
 *
 * This replaces `recommendationGeneration`, which digested the snapshot's `evidence_refs` — the
 * CANDIDATE's eligibility evidence — and handed the result to a comparison against the ITEM's
 * condition evidence. Two record sets about two different subjects, compared for equality, so no
 * item the real cycle created could execute (R2F-F-017).
 *
 * Everything read here was written server-side by the create RPC, in the transaction that wrote
 * the evidence. The parameter digest is RE-DERIVED from the stored plan rather than read from its
 * column, so a stored digest that disagreed with the plan it describes cannot authorise anything —
 * the column is a convenience, never the trust anchor.
 *
 * Null when no snapshot carries a plan, which is fail-closed: an automatic action with no recorded
 * plan was authorised against nothing.
 */
async function loadPlan(
  sql: SqlExec,
  companyId: string,
  itemId: string,
): Promise<RecommendationPlan | null> {
  const { rows } = await sql(
    `select id, condition_evidence_digest, action_id, planned_parameters, parameter_digest,
            policy_version
       from management_item_recommendations
      where company_id = $1 and item_id = $2 and condition_evidence_digest is not null
      order by created_at desc
      limit 1`,
    [companyId, itemId],
  );
  const row = rows[0];
  if (!row) return null;

  const stored = row.parameter_digest == null ? null : String(row.parameter_digest);
  const derived =
    row.planned_parameters == null ? null : digestOfPlannedParameters(row.planned_parameters);
  // A plan whose stored digest disagrees with its own parameters is not a plan anyone can rely
  // on. Returning the derived value would quietly repair it; returning a value that matches
  // nothing refuses it.
  const parameterDigest =
    derived !== null && stored !== null && derived !== stored ? "plan-inconsistent" : (derived ?? "no-parameters");

  return {
    conditionEvidenceDigest: String(row.condition_evidence_digest),
    actionId: String(row.action_id ?? ""),
    parameterDigest,
    policyVersion: String(row.policy_version ?? ""),
    version: String(row.id),
  };
}

/** Build the real dependencies. Every loader is company-scoped and re-checks what it read. */
export function buildExecutorDeps(env: ExecutionEnvironment): ExecutorDeps {
  const { sql } = env;

  return {
    localToken: env.localToken,

    async companyExecutionEnabled(companyId) {
      // The SEPARATE switch. Deliberately not a join with `management_kernel_enablement`: a
      // company may be observed without being acted upon, and one query returning both would
      // make it easy to accidentally read the wrong one.
      const { rows } = await sql(
        `select enabled from management_execution_enablement where company_id = $1`,
        [companyId],
      );
      return rows[0]?.enabled === true;
    },

    async loadApproval(req): Promise<ApprovalSnapshot | null> {
      const { rows } = await sql(
        `select id, company_id, actor_id, decision, authority_level, created_at
           from management_item_decisions
          where company_id = $1 and item_id = $2 and decision = 'approve'
          order by created_at desc
          limit 1`,
        [req.companyId, req.itemId],
      );
      const row = rows[0];
      if (!row) return null;

      // Superseded by ANY later decision, not merely by a later approval: a rejection or an edit
      // after the approval replaces it just as surely.
      const { rows: laterRows } = await sql(
        `select count(*)::int as n
           from management_item_decisions
          where company_id = $1 and item_id = $2 and created_at > $3`,
        [req.companyId, req.itemId, row.created_at],
      );
      const superseded = Number(laterRows[0]?.n ?? 0) > 0;

      return {
        approvedBy: asUserId(String(row.actor_id)),
        actionId: req.actionId,
        authority: (row.authority_level as ApprovalSnapshot["authority"]) ?? "owner_approval",
        current: !superseded,
        decisionVersion: String(row.id),
        evidenceGeneration: await evidenceGeneration(sql, req.companyId, req.itemId),
        // Re-read from the row, never assumed from the filter.
        companyId: asCompanyId(String(row.company_id)),
      };
    },

    async loadItem(req): Promise<ItemSnapshot | null> {
      const { rows } = await sql(
        `select i.company_id, i.state, i.proposed_action_id,
                (select count(*)::int from management_item_evidence e
                  where e.item_id = i.id) as evidence_count
           from management_items i
          where i.company_id = $1 and i.id = $2`,
        [req.companyId, req.itemId],
      );
      const row = rows[0];
      if (!row) return null;

      return {
        state: String(row.state),
        evidenceCount: Number(row.evidence_count ?? 0),
        // `proposed_action_id` (draft 009), NOT `proposed_action` (draft 001). Both columns
        // exist; only this one is ever written — the atomic create RPC populates it and nothing
        // populates the other. Reading the wrong one made every real item look actionless and
        // refuse with `stale_state`, while a test that seeded the same wrong column passed
        // (R2E-F-010).
        actionId: String(row.proposed_action_id ?? ""),
        evidenceGeneration: await evidenceGeneration(sql, req.companyId, req.itemId),
        plan: await loadPlan(sql, req.companyId, req.itemId),
        companyId: asCompanyId(String(row.company_id)),
      };
    },

    async approverCapabilities(req) {
      if (!req.approvedBy) return new Set<string>();
      const { rows } = await sql(
        `select rp.permission_key
           from user_company_access uca
           join role_permissions rp on rp.role_key = uca.role_key
          where uca.user_id = $1 and uca.company_id = $2`,
        [req.approvedBy, req.companyId],
      );
      return new Set(rows.map((r) => String(r.permission_key)));
    },

    ledger: createSqlLedger(sql),

    handlers: {
      // The real command, the real transport, the real atomic RPC. Never the FormData action.
      "ops.task.create_internal.v1": async (req) => {
        const p = req.validatedParameters as {
          title: string;
          description: string | null;
          requiresEvidence: boolean;
        };
        const out = await createInternalTask(idempotentRpcTransport(env.rpc), {
          companyId: req.companyId,
          idempotencyKey: req.idempotencyKey,
          title: p.title,
          description: p.description,
          requiresEvidence: p.requiresEvidence,
          // Attributed to the approver when there is one, and to NOBODY when the action ran
          // automatically. Never to a fabricated system user (R2E-F-009).
          createdBy: req.approvedBy,
        });
        if (!out.ok) throw new Error(`${out.code}: ${out.message}`);
        return { effectRef: out.taskId, created: out.created };
      },
    },

    audit: env.audit,
  };
}

/**
 * The service entrypoint.
 *
 * The global boundary is checked HERE as well as inside the executor. That is not redundancy for
 * its own sake: this check happens before `buildExecutorDeps`, so a disabled system does not even
 * construct a ledger, a transport or a handler — there is nothing assembled that could be invoked
 * by mistake.
 */
export async function executeManagementAction(
  env: ExecutionEnvironment,
  input: ExecutionServiceInput,
): Promise<ExecutionOutcome> {
  const globallyOn: boolean = EXECUTION_GLOBALLY_ENABLED;
  if (!globallyOn && env.localToken !== LOCAL_EXECUTION_TOKEN) {
    return refuse("global_boundary_disabled", "execution is disabled at the global boundary");
  }

  const request: ExecutionRequest = {
    companyId: asCompanyId(input.companyId),
    itemId: input.itemId,
    actionId: input.actionId,
    // NOT caller-supplied. The approver is whoever the decision record names; for an automatic
    // action there is none. A caller asserting an approver is a caller asserting an approval.
    approvedBy: null,
    parameters: input.parameters,
    requestedAt: new Date(),
  };

  const deps = buildExecutorDeps(env);

  // For an approval-requiring action the executor compares `req.approvedBy` with the decision's
  // actor, so the request is re-issued naming the approver the DATABASE reported.
  const approval = await deps.loadApproval(request);
  const withApprover: ExecutionRequest = approval
    ? { ...request, approvedBy: approval.approvedBy }
    : request;

  return executeApprovedAction(deps, withApprover);
}
