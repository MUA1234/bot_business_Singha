/**
 * Transports for the internal-task command.
 *
 * Both MUST throw on failure. `createInternalTask` turns a throw into a `database_error` result;
 * a transport that returned a success-shaped value on failure would put the swallowed error
 * straight back (R2E-F-002).
 */
import type { TaskCreateTransport } from "@/modules/work/create-internal-task";

/** The minimum of the Supabase client surface these transports use. */
export interface RpcCapableClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface InsertCapableClient {
  from(table: string): {
    insert(row: Record<string, unknown>): {
      select(cols: string): {
        maybeSingle(): PromiseLike<{
          data: { id: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/**
 * R2E's transport: the atomic RPC that claims the idempotency key BEFORE the task exists, so two
 * concurrent callers with one key produce one task and one of them is told `created: false`.
 *
 * The function is service-only, so this transport must be constructed with a service-role client
 * and never with a session client — an authenticated caller reaching the handler directly would
 * bypass the executor's boundary, policy, authority and approval checks entirely.
 */
export function idempotentRpcTransport(db: RpcCapableClient): TaskCreateTransport {
  return {
    async create(p) {
      const { data, error } = await db.rpc("r1_draft_create_internal_task", {
        p_company_id: p.companyId,
        p_idempotency_key: p.idempotencyKey,
        p_title: p.title,
        p_description: p.description,
        p_requires_evidence: p.requiresEvidence,
        p_created_by: p.createdBy,
      });
      if (error) throw new Error(error.message);

      // The RPC returns a one-row set. Anything else means the contract changed underneath us,
      // and guessing at it would be how a caller ends up recording an execution with no task.
      const row = Array.isArray(data) ? data[0] : data;
      const taskId = (row as { task_id?: string } | null)?.task_id;
      const created = (row as { created?: boolean } | null)?.created;
      if (!taskId || typeof created !== "boolean") {
        throw new Error("r1_draft_create_internal_task returned an unrecognised row");
      }
      return { taskId, created };
    },
  };
}

/**
 * The UI's transport: the ordinary insert the product already performs.
 *
 * It reports failure by throwing, which is the whole point — the action it replaces returned
 * normally on a failed insert. It offers no idempotency, because supplying one would require an
 * idempotency column on `tasks`, and `tasks` is a hosted production table this phase may not
 * alter. `created` is therefore always `true`: this transport cannot detect a replay, and saying
 * so is better than implying a guarantee it does not have.
 */
export function directInsertTransport(db: InsertCapableClient): TaskCreateTransport {
  return {
    async create(p) {
      const { data, error } = await db
        .from("tasks")
        .insert({
          company_id: p.companyId,
          title: p.title,
          description: p.description,
          status: "captured",
          requires_evidence: p.requiresEvidence,
          created_by: p.createdBy,
        })
        .select("id")
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data?.id) throw new Error("task insert returned no id");
      return { taskId: data.id, created: true };
    },
  };
}
