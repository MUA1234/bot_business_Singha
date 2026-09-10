/**
 * The execution ledger, over SQL.
 *
 * ── Why the claim does not pre-check ─────────────────────────────────────────────────────────
 *
 * The tempting shape is "SELECT to see whether this key exists, then INSERT if it does not".
 * That is a check-then-act race: two callers both see nothing and both insert, and the duplicate
 * appears in exactly the concurrent case the check was added to prevent.
 *
 * So the claim is a single `INSERT … ON CONFLICT DO NOTHING RETURNING id`. The unique index
 * `(company_id, idempotency_key)` arbitrates. A caller that gets no row lost the race or is a
 * replay, and only THEN reads the winner — a read that is safe precisely because it happens after
 * the database has already decided.
 *
 * ── Why a `resuming` claim is distinguished from a fresh one ─────────────────────────────────
 *
 * An `attempting` row that already exists is the signature of a crash between claiming and
 * resolving. It is not an error and must not be treated as a duplicate: the effect may or may not
 * have been created, and the only way to find out is to re-invoke the handler, which is idempotent
 * under the same key and will say which it was.
 */
import type { CompanyId, UserId } from "../ask-ai/identity";
import type { CatalogueActionId } from "../catalogue";
import type { ExecutionHandlerKey, RefusalReason } from "./contract";
import type { ClaimResult, LedgerPort } from "./executor";

/** The minimum SQL surface the ledger needs. Postgres placeholders (`$1`). */
export type SqlExec = (
  sql: string,
  params: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/** A lease long enough that a live attempt is not mistaken for a crashed one. */
const LEASE_SECONDS = 300;

export function createSqlLedger(exec: SqlExec): LedgerPort {
  return {
    async claim(row): Promise<ClaimResult> {
      const inserted = await exec(
        `insert into management_execution_attempts
           (company_id, item_id, action_id, idempotency_key, status,
            handler, approved_by, resolved_authority, lease_expires_at)
         values ($1, $2, $3, $4, 'attempting', $5, $6, $7, now() + ($8 || ' seconds')::interval)
         on conflict (company_id, idempotency_key) do nothing
         returning id`,
        [
          row.companyId,
          row.itemId,
          row.actionId,
          row.idempotencyKey,
          row.handler,
          row.approvedBy,
          row.resolvedAuthority,
          String(LEASE_SECONDS),
        ],
      );

      const fresh = inserted.rows[0]?.id as string | undefined;
      if (fresh) return { ledgerId: fresh, kind: "fresh", effectRef: null };

      // Lost the race, replayed, or resuming after a crash. Ask the database which.
      const existing = await exec(
        `select id, status, effect_ref
           from management_execution_attempts
          where company_id = $1 and idempotency_key = $2`,
        [row.companyId, row.idempotencyKey],
      );
      const found = existing.rows[0];
      if (!found) {
        // The insert conflicted, so a row exists; not seeing it means this transaction's snapshot
        // predates the winner's commit. Failing loudly beats returning a claim we do not hold.
        throw new Error(
          "idempotency key conflicted but is not visible — isolation level must be READ COMMITTED",
        );
      }

      const status = String(found.status);
      const ledgerId = String(found.id);
      const effectRef = (found.effect_ref as string | null) ?? null;

      if (status === "attempting") return { ledgerId, kind: "resuming", effectRef };
      if (status === "executed") return { ledgerId, kind: "executed", effectRef };
      if (status === "refused") return { ledgerId, kind: "refused", effectRef };
      return { ledgerId, kind: "failed", effectRef };
    },

    async resolveExecuted(ledgerId, effectRef) {
      const r = await exec(
        `update management_execution_attempts
            set status = 'executed', effect_ref = $2, completed_at = now()
          where id = $1 and status = 'attempting'
          returning id`,
        [ledgerId, effectRef],
      );
      // A resolve that changed nothing means the row is already terminal — the caller would
      // otherwise report an execution the ledger does not record.
      if (r.rows.length === 0) {
        throw new Error(`execution attempt ${ledgerId} was not in 'attempting' and was not resolved`);
      }
    },

    async resolveFailed(ledgerId, error) {
      await exec(
        `update management_execution_attempts
            set status = 'failed', detail = $2, completed_at = now()
          where id = $1 and status = 'attempting'`,
        // Bounded: a driver's error text can be long, and the ledger is not a log.
        [ledgerId, error.slice(0, 500)],
      );
    },

    async recordRefusal(row) {
      // Under its OWN key. A refusal must not consume the caller's idempotency key, or a request
      // refused today for a missing approval could never be executed once the approval exists.
      await exec(
        `insert into management_execution_attempts
           (company_id, item_id, action_id, idempotency_key, status,
            refusal_reason, detail, completed_at)
         values ($1, $2, $3, $4, 'refused', $5, $6, now())`,
        [
          row.companyId,
          row.itemId,
          row.actionId,
          `${row.idempotencyKey}#refused#${cryptoRandom()}`,
          row.reason satisfies RefusalReason,
          row.detail.slice(0, 500),
        ],
      );
    },
  };
}

/** Small, dependency-free unique suffix. Not security-sensitive: it only separates ledger rows. */
function cryptoRandom(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Re-exported for callers that build a request. */
export type { CompanyId, UserId, CatalogueActionId, ExecutionHandlerKey };
