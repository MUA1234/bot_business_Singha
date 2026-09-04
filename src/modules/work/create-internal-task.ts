/**
 * The typed internal-task-creation command (R2E-F-002).
 *
 * ── What was wrong with the thing this replaces ──────────────────────────────────────────────
 *
 * `createTask` in `src/app/app/operations/tasks/actions.ts` is a Next.js server action. It takes
 * `FormData`, reads its identity from the session, calls `revalidatePath`, and — the part that
 * matters — contains this:
 *
 *     if (error) return;   // table missing (pre-migration) → no-op, no crash
 *
 * A failed insert returns normally. A caller cannot distinguish "created" from "silently did
 * nothing". An executor built on it would write a successful execution record for a task that does
 * not exist, which is the precise failure R2E exists to make impossible.
 *
 * ── The shape here ───────────────────────────────────────────────────────────────────────────
 *
 * Typed parameters, validated by Zod, and a DISCRIMINATED result. There is no success-shaped
 * return for a failure and no thrown error that a caller might not catch. A database error is
 * reported as `database_error` carrying its message — reported, never swallowed, and never
 * converted into a quiet success.
 *
 * ── What this command deliberately cannot do ─────────────────────────────────────────────────
 *
 * It cannot assign a person. There is no `assignedTo` parameter and no transport that accepts one.
 * Assignment is a separate authority, and an argument the function does not accept is an authority
 * it cannot be talked into exercising.
 *
 * ── Idempotency is a property of the TRANSPORT, and the two callers differ ────────────────────
 *
 * Both the UI wrapper and the R2E handler use this command, its validation and its result type.
 * They inject different transports, and the difference is stated rather than hidden:
 *
 *   * `IdempotentRpcTransport` (R2E) calls `r1_draft_create_internal_task`, which claims the key
 *     before the task exists and is therefore exactly-once under concurrency.
 *   * `DirectInsertTransport` (the UI) performs the ordinary insert the product already performs.
 *
 * The UI does not get the durable guarantee because supplying it would require an idempotency
 * column on `tasks`, and `tasks` is a hosted production table that this phase may not alter. What
 * the UI DOES get is the end of the silent failure above.
 */
import { z } from "zod";
import type { CompanyId, UserId } from "@/kernel/ask-ai/identity";

/** Validated at the boundary. A title that is only whitespace is not a title. */
export const TaskCreateParamsSchema = z
  .object({
    companyId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(5000).nullable(),
    requiresEvidence: z.boolean(),
    createdBy: z.string().uuid(),
  })
  .strict();

export interface TaskCreateParams {
  readonly companyId: CompanyId;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly description: string | null;
  readonly requiresEvidence: boolean;
  readonly createdBy: UserId;
}

/**
 * The result. `created: false` means the key had already been used and the task already existed —
 * an idempotent replay, not a new effect.
 */
export type TaskCreateResult =
  | { readonly ok: true; readonly taskId: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly code: "invalid_input" | "database_error";
      readonly message: string;
    };

/**
 * How the command reaches the database. MUST throw on failure — the command converts a throw into
 * a `database_error` result. A transport that returns a success-shaped value on failure would
 * reintroduce exactly the defect this file exists to remove.
 */
export interface TaskCreateTransport {
  create(p: {
    companyId: string;
    idempotencyKey: string;
    title: string;
    description: string | null;
    requiresEvidence: boolean;
    createdBy: string;
  }): Promise<{ taskId: string; created: boolean }>;
}

/**
 * Create one internal, UNASSIGNED task.
 *
 * Authorisation is the CALLER's responsibility and is not duplicated here: the UI wrapper holds
 * `requireOps()`, and the R2E executor holds the boundary, policy, authority and approval checks.
 * A command that re-derived permission from its own arguments would be trusting the argument.
 */
export async function createInternalTask(
  transport: TaskCreateTransport,
  params: TaskCreateParams,
): Promise<TaskCreateResult> {
  const parsed = TaskCreateParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_input",
      // Field paths only. Never the values, which may carry business content.
      message: parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", "),
    };
  }

  try {
    const out = await transport.create({
      companyId: parsed.data.companyId,
      idempotencyKey: parsed.data.idempotencyKey,
      title: parsed.data.title,
      description: parsed.data.description,
      requiresEvidence: parsed.data.requiresEvidence,
      createdBy: parsed.data.createdBy,
    });

    // A transport that returns no id has not created a task, whatever it claims.
    if (!out?.taskId) {
      return { ok: false, code: "database_error", message: "transport returned no task id" };
    }
    return { ok: true, taskId: out.taskId, created: out.created };
  } catch (e) {
    return { ok: false, code: "database_error", message: (e as Error).message };
  }
}
