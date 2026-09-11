/**
 * The PostgREST execution transport (R2F-F-019).
 *
 * `executeManagementAction` reached its ledger and its four loaders through `SqlExec` — a raw SQL
 * executor. The request path speaks PostgREST, which cannot run arbitrary SQL, so `makeCycleDeps`
 * supplied no transport at all: the orchestrator recorded an "execution transport unavailable"
 * hold and marked the cycle partial. The loop's one authorised effect was unreachable from the
 * deployed graph, which is the definition of an incomplete capability.
 *
 * The obvious fix — expose an RPC that runs SQL text — would be a remote code execution primitive
 * wearing a function signature. Nothing here does that. Every call below is a named RPC with
 * explicitly typed arguments, defined in `R1_DRAFT_029_execution_transport.up.sql`, granted only
 * to `service_role`, and gated again inside the function on `caller_jwt_role()`.
 *
 * ── What the caller may and may not say ─────────────────────────────────────────────────────
 *
 * No call passes an authority level, an entitlement, a membership, or "this caller is allowed".
 * A company id travels because a query needs a subject, and every function RE-READS the row's own
 * `company_id` and compares before returning anything — so passing company A with item B yields
 * nothing rather than B's data labelled A. Authority is derived server-side from stored decisions
 * and stored role grants, inside the transaction that uses it.
 *
 * ── Why the execute is one call and not three ───────────────────────────────────────────────
 *
 * The SQL path claims, invokes the handler, then resolves the ledger — three round trips with no
 * transaction spanning them. A crash between the second and third leaves a task that exists with
 * no ledger row saying so, and the next retry, finding no terminal row, creates a SECOND task for
 * the same customer. `r1_exec_create_internal_task` does all three in one statement, so the
 * failure mode is unreachable rather than merely unlikely.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyId, UserId } from "../ask-ai/identity";
import { asCompanyId, asUserId } from "../ask-ai/identity";
import type { CatalogueActionId } from "../catalogue";
import { REFUSAL_REASONS, type ExecutionHandlerKey, type RefusalReason } from "./contract";
import { digestOfPlannedParameters } from "./plan";
import type { RpcCapableClient } from "./transports";
import type {
  ApprovalSnapshot,
  ExecutorDeps,
  ItemSnapshot,
  LedgerPort,
  RecommendationPlan,
} from "./executor";

/**
 * The client surface this transport needs — the SAME one `transports.ts` already declares, not a
 * second structurally-identical interface that would be free to drift from it.
 */
export type RpcClient = RpcCapableClient;

/** Every RPC name this transport may call. There is no dynamic name and no SQL text. */
export const EXECUTION_RPCS = [
  "r1_exec_company_enabled",
  "r1_exec_load_item",
  "r1_exec_load_approval",
  "r1_exec_approver_capabilities",
  "r1_exec_create_internal_task",
  "r1_exec_record_refusal",
] as const;

/**
 * The plan's parameter digest, on exactly `loadPlan`'s terms.
 *
 * Re-derived from the stored parameters rather than read from the stored column, so a column that
 * disagrees with the plan it describes authorises nothing — and when the two disagree the answer
 * is `plan-inconsistent`, a value that matches nothing, rather than the derived one. Returning
 * the derived value would quietly repair a plan whose own record of itself is wrong.
 */
function planParameterDigest(planRaw: Record<string, unknown>): string {
  const stored = planRaw.storedParameterDigest == null ? null : String(planRaw.storedParameterDigest);
  const params = planRaw.plannedParameters;
  const derived = params == null ? null : digestOfPlannedParameters(params);
  if (derived !== null && stored !== null && derived !== stored) return "plan-inconsistent";
  return derived ?? "no-parameters";
}

async function call(db: RpcClient, fn: (typeof EXECUTION_RPCS)[number], args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/**
 * The refusal vocabulary, taken from the union itself rather than restated.
 *
 * An earlier draft of this file kept a hand-written list of reason strings the RPC "may return",
 * and every one of them was a name the `RefusalReason` union does not contain — so the cast at
 * the bottom of `atomicExecute` was inventing a type rather than checking one. Deriving the set
 * from `REFUSAL_REASONS` makes the check real: a reason the union does not name cannot pass.
 */
const TRANSPORT_REFUSALS: ReadonlySet<string> = new Set<string>(REFUSAL_REASONS);

/**
 * Build the four loaders and the atomic execute over PostgREST.
 *
 * Returns the pieces of `ExecutorDeps` this transport owns. The caller supplies the rest —
 * handlers, audit — because those are not transport concerns.
 */
export function createPostgrestExecutionPorts(db: RpcClient): Pick<
  ExecutorDeps,
  "companyExecutionEnabled" | "loadItem" | "loadApproval" | "approverCapabilities" | "atomicExecute"
> {
  return {
    async companyExecutionEnabled(companyId: CompanyId): Promise<boolean> {
      // Absent row means disabled. Never "unknown, assume yes".
      return (await call(db, "r1_exec_company_enabled", { p_company: companyId })) === true;
    },

    async loadItem(req): Promise<ItemSnapshot | null> {
      const row = (await call(db, "r1_exec_load_item", {
        p_company: req.companyId,
        p_item: req.itemId,
      })) as Record<string, unknown> | null;
      if (!row) return null;

      const planRaw = row.plan as Record<string, unknown> | null;
      const plan: RecommendationPlan | null = planRaw
        ? {
            conditionEvidenceDigest: String(planRaw.conditionEvidenceDigest),
            actionId: String(planRaw.actionId ?? ""),
            // Derived HERE, by the same function `loadPlan` calls, from the raw parameters the
            // RPC returned. Not computed in SQL: `canonicalHash` is sha256 over a rendering with
            // JSON.stringify's exact escaping and key order, and a SQL reimplementation of it
            // would be a second definition of one value. The first version of this transport had
            // one, it disagreed on the first real item, and the parity suite caught it.
            parameterDigest: planParameterDigest(planRaw),
            policyVersion: String(planRaw.policyVersion ?? ""),
            version: String(planRaw.version),
          }
        : null;

      return {
        state: String(row.state),
        evidenceCount: Number(row.evidenceCount ?? 0),
        actionId: String(row.actionId ?? ""),
        evidenceGeneration: String(row.evidenceGeneration),
        plan,
        // Read back from the row the function returned, which is the row's OWN company.
        companyId: asCompanyId(String(row.companyId)),
      };
    },

    async loadApproval(req): Promise<ApprovalSnapshot | null> {
      const row = (await call(db, "r1_exec_load_approval", {
        p_company: req.companyId,
        p_item: req.itemId,
        p_action: req.actionId,
      })) as Record<string, unknown> | null;
      if (!row) return null;

      return {
        approvedBy: asUserId(String(row.approvedBy)),
        actionId: req.actionId,
        authority: (row.authority as ApprovalSnapshot["authority"]) ?? "owner_approval",
        current: row.current === true,
        decisionVersion: String(row.decisionVersion),
        evidenceGeneration: String(row.evidenceGeneration),
        companyId: asCompanyId(String(row.companyId)),
      };
    },

    async approverCapabilities(req): Promise<ReadonlySet<string>> {
      if (!req.approvedBy) return new Set<string>();
      const caps = (await call(db, "r1_exec_approver_capabilities", {
        p_company: req.companyId,
        p_user: req.approvedBy,
      })) as string[] | null;
      return new Set((caps ?? []).map(String));
    },

    async atomicExecute(req) {
      // NO PARAMETERS TRAVEL. Not the title, not the description, not the evidence flag, and —
      // as before — no assignee. The function reads the plan row inside its own transaction and
      // takes the parameters from there, so a caller who could name a title cannot; the digest
      // below only says WHICH plan the executor read, and the function refuses if that is no
      // longer the plan.
      const out = (await call(db, "r1_exec_create_internal_task", {
        p_company: req.companyId,
        p_item: req.itemId,
        p_action: req.actionId,
        p_idempotency_key: req.idempotencyKey,
        p_parameter_digest: req.parameterDigest,
        p_policy_version: req.policyVersion,
        p_condition_digest: req.conditionEvidenceDigest,
        p_eligibility_digest: req.eligibilityDigest,
      })) as Record<string, unknown> | null;

      if (!out) throw new Error("r1_exec_create_internal_task returned nothing");

      if (out.ok === true) {
        return {
          kind: "executed" as const,
          ledgerId: String(out.ledgerId),
          effectRef: String(out.taskId),
          created: out.created === true,
        };
      }

      if (out.terminal === true) {
        // A prior verdict under the same execution identity, not a fresh refusal.
        return {
          kind: "terminal" as const,
          ledgerId: String(out.ledgerId),
          status: String(out.status ?? "unknown"),
        };
      }

      const reason = String(out.reason ?? "");
      if (!TRANSPORT_REFUSALS.has(reason)) {
        // An unrecognised reason is not a refusal to be reported calmly — it means the transport
        // and this file disagree about the contract, and continuing would report a guess.
        throw new Error(`r1_exec_create_internal_task returned an unknown refusal: ${reason}`);
      }
      return { kind: "refused" as const, reason: reason as RefusalReason, detail: reason };
    },
  };
}

/**
 * The ledger, over PostgREST.
 *
 * Only `recordRefusal` is reachable. `claim`, `resolveExecuted` and `resolveFailed` are the
 * three-round-trip sequence that `atomicExecute` replaces, and reaching them on this transport
 * would mean the atomic path had been removed while its transport stayed — the exact mutation
 * task 2 asks to be caught. They throw rather than doing something reasonable, because doing
 * something reasonable here is how a non-atomic ledger/effect ordering gets reintroduced quietly.
 */
export function createPostgrestLedger(db: RpcClient): LedgerPort {
  const unreachable = (op: string) => (): never => {
    throw new Error(
      `ledger.${op} is unreachable on the PostgREST transport: the claim, the effect and the ` +
        "terminal result are one transaction in r1_exec_create_internal_task",
    );
  };

  return {
    claim: unreachable("claim"),
    resolveExecuted: unreachable("resolveExecuted"),
    resolveFailed: unreachable("resolveFailed"),

    async recordRefusal(row) {
      // The idempotency key is NOT consumed: the RPC appends its own unique suffix server-side,
      // so this holds even if a future caller passes the bare key.
      const out = (await call(db, "r1_exec_record_refusal", {
        p_company: row.companyId,
        p_item: row.itemId,
        p_action: row.actionId,
        p_idempotency_key: row.idempotencyKey,
        p_reason: row.reason,
        p_detail: row.detail.slice(0, 500),
      })) as Record<string, unknown> | null;

      if (!out || out.ok !== true) {
        // A ledger that did not record the refusal must say so. A swallowed failure here would
        // make a system that refuses everything indistinguishable from one nobody asked.
        throw new Error(`r1_exec_record_refusal refused: ${String(out?.reason ?? "no response")}`);
      }
    },
  };
}

/**
 * The Supabase client satisfies `RpcClient` structurally; this narrows it explicitly so a caller
 * passing the wrong client is a type error rather than a runtime one.
 */
export function postgrestPortsFromSupabase(db: SupabaseClient): ReturnType<typeof createPostgrestExecutionPorts> {
  return createPostgrestExecutionPorts({
    async rpc(fn, args) {
      const { data, error } = await db.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
  });
}

/** Re-exported so callers do not need to import the handler-key type separately. */
export type { ExecutionHandlerKey, CatalogueActionId, UserId };
