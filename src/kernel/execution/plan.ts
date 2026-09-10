/**
 * Grounded action planning: what the system proposes to DO, decided when the advice is recorded.
 *
 * ── Why a plan has to exist at all ───────────────────────────────────────────────────────────
 *
 * The owner requires execution to refuse when "the parameters changed". Nothing could detect that,
 * because nothing ever decided what the parameters should be: the executor validated whatever a
 * caller handed it, and the decision RPC stored a parameter digest the browser supplied. A digest
 * with nothing to compare against is a field, not a control.
 *
 * So the parameters are planned HERE, deterministically, from the observation that raised the item,
 * at the moment the recommendation is recorded. Execution then compares the parameters it was given
 * against the plan the approver — or the automatic policy — actually stood behind.
 *
 * ── Why the text carries no business content ─────────────────────────────────────────────────
 *
 * A planned title is written into a task that a wider audience can read than the evidence behind
 * it. The detectors are already careful about this: `management_item_evidence.facts` carries an
 * exception type and a status and never a task title, because titles are written by people and
 * carry customer and personnel detail. The plan holds to the same line — it names the CONDITION and
 * the RECORD, never their contents.
 *
 * PURE. No clock, no database, no randomness: the same observation plans the same parameters on any
 * machine, which is what makes the digest comparison meaningful rather than decorative.
 */
import type { CatalogueActionId } from "../catalogue";
import { canonicalHash, validateParameters } from "./parameters";

/** What the item is about, in the only terms a plan is allowed to use. */
export interface PlannableItem {
  readonly kind: string;
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly department: string;
}

export interface ActionPlan {
  readonly actionId: CatalogueActionId;
  readonly parameters: Record<string, unknown>;
  readonly parameterDigest: string;
}

/** Human-readable without being human-written: `missing_estimate` → `missing estimate`. */
const readable = (s: string) => s.replace(/_/g, " ").trim();

/**
 * Plan the parameters for one action against one item, or `null` when the action has no plan.
 *
 * `null` is a legitimate answer and the common one: thirteen of the fifteen catalogue actions are
 * draft-only and have no handler, so there is nothing to plan. It is never a reason to improvise.
 */
export function planAction(actionId: string, item: PlannableItem): ActionPlan | null {
  if (actionId !== "ops.task.create_internal") return null;

  const parameters = {
    // The condition and the record it is about. No title, no name, no amount.
    title: `Follow up: ${readable(item.kind)} on ${item.subjectTable}`,
    description:
      `Raised by the ${readable(item.department)} observation of ${item.subjectTable} ` +
      `${item.subjectId}. Created unassigned; a manager assigns it.`,
    requiresEvidence: false,
  };

  // Validated through the SAME strict schema execution will use. A plan that would be rejected at
  // execution is not a plan, and failing here is better than failing after an item has been
  // recommended on the strength of it.
  const validated = validateParameters(actionId, parameters);
  if (!validated.ok) return null;

  return {
    actionId: actionId as CatalogueActionId,
    parameters: validated.value,
    // Over the VALIDATED value, exactly as the executor will hash what it is given.
    parameterDigest: canonicalHash(validated.value),
  };
}

/** Re-derive a digest from stored planned parameters, so the column is never the trust anchor. */
export function digestOfPlannedParameters(parameters: unknown): string {
  return canonicalHash(parameters);
}
