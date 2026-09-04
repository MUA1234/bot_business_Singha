/**
 * Strict per-action parameter schemas, and the canonical hash of a validated parameter set.
 *
 * ── Why strict, and why per action (R2E-F-007) ───────────────────────────────────────────────
 *
 * Before this, `parameters` was `Record<string, unknown>` and the executor never looked at it: it
 * went straight to the handler, which coerced fields out of it. An `assignedTo` key riding along in
 * that bag was harmless only because the RPC happens not to accept one — a property of a different
 * file, one refactor away from not being true.
 *
 * `.strict()` means an unknown key is a REJECTION, not something quietly dropped. Dropping it would
 * mean a caller who believed they were assigning someone gets a task assigned to nobody and no
 * indication that the difference occurred.
 *
 * ── Why the hash is over the PARSED value ────────────────────────────────────────────────────
 *
 * The idempotency identity must be stable across retries of the same decision and different across
 * different ones. Hashing the raw input would make `{title:"x"}` and `{title:"x", stray:1}` two
 * different identities for what the schema says is one request — so a caller could manufacture
 * fresh identities, and duplicate the effect, by appending junk. The hash is therefore taken after
 * validation, over the value the handler will actually see.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CatalogueActionId } from "../catalogue";

/**
 * `ops.task.create_internal` — internal, unassigned task creation.
 *
 * There is deliberately no `assignedTo`, `assigneeId`, `dueDate`, `priority` or `projectId`.
 * Assigning a person, committing to a date and setting priority are each separate decisions with
 * their own authority; a field the schema does not accept is an authority this action cannot
 * quietly acquire.
 */
export const CreateInternalTaskParams = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(5000).nullable().default(null),
    requiresEvidence: z.boolean().default(false),
  })
  .strict();

export type CreateInternalTaskParams = z.infer<typeof CreateInternalTaskParams>;

/**
 * The schema for each action that can be executed. Only `locally_executable` actions appear:
 * a draft-only action has no handler to hand parameters to, and giving it a schema would suggest
 * otherwise.
 */
const PARAMETER_SCHEMAS = {
  "ops.task.create_internal": CreateInternalTaskParams,
} as const satisfies Partial<Record<CatalogueActionId, z.ZodTypeAny>>;

export type ParameterValidation =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly hash: string }
  | { readonly ok: false; readonly message: string };

/**
 * Validate an action's parameters and derive their canonical hash.
 *
 * An action with no schema fails CLOSED. That is not a gap to fill later: an action with no schema
 * has no handler, so there is nothing for parameters to mean.
 */
export function validateParameters(
  actionId: string,
  raw: Readonly<Record<string, unknown>>,
): ParameterValidation {
  if (!Object.hasOwn(PARAMETER_SCHEMAS, actionId)) {
    return { ok: false, message: `no parameter schema is registered for "${actionId}"` };
  }
  const schema = PARAMETER_SCHEMAS[actionId as keyof typeof PARAMETER_SCHEMAS];

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      // Field paths only. The VALUES may carry business content, and a refusal detail is written to
      // a ledger that a wider audience can read than the parameters themselves.
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
        .join(", "),
    };
  }

  const value = parsed.data as Record<string, unknown>;
  return { ok: true, value, hash: canonicalHash(value) };
}

/**
 * A stable hash of a value, independent of key order.
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}` would otherwise hash
 * differently and give one decision two idempotency identities — which is precisely a duplicate
 * effect waiting for a caller who builds the object in a different order.
 */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The durable execution identity (owner condition 9).
 *
 * Derived entirely from values the SERVER holds — never from a caller-supplied key (R2E-F-005).
 * The same decision retried yields the same identity, so a retry cannot duplicate. A different
 * decision, a different approval version, a different evidence generation or different parameters
 * yields a different identity, so two genuinely distinct actions cannot collide into one.
 */
export function deriveIdempotencyKey(input: {
  companyId: string;
  itemId: string;
  actionId: string;
  /** The approval/decision version, or the recommendation version for an automatic action. */
  decisionVersion: string;
  evidenceGeneration: string;
  parameterHash: string;
}): string {
  // Length-prefixed, so no field's content can be arranged to look like a field boundary.
  const parts = [
    input.companyId,
    input.itemId,
    input.actionId,
    input.decisionVersion,
    input.evidenceGeneration,
    input.parameterHash,
  ];
  const packed = parts.map((p) => `${p.length}:${p}`).join("|");
  return `r2e:${createHash("sha256").update(packed).digest("hex")}`;
}
