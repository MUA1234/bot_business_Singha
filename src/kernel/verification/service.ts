/**
 * The verification runtime path.
 *
 * Loads the item and its originating record through the storage port, asks the boundary, and
 * applies the lifecycle transition through the existing `r1_draft_transition_item()` — which
 * re-locks the item and re-checks the from-state, so two concurrent verifications cannot produce
 * conflicting terminal outcomes.
 *
 * The re-read is TARGETED: the exact originating record, by the identity the item recorded. Nothing
 * here infers resolution from absence, and nothing consults `updated_at`.
 *
 * This is the ONLY verification implementation. It reaches a database through `VerificationStore`,
 * of which there are two transports — direct PostgreSQL and Supabase — and neither of them decides
 * anything.
 */
import {
  type ItemUnderVerification,
  type SweepState,
  type VerificationResult,
  result,
} from "./contract";
import type { Department } from "../types";
import type { VerificationStore } from "./store";
import { verifyOutcome } from "./verify";

export interface VerificationEnvironment {
  readonly store: VerificationStore;
  /** Injected so a test can drive time deterministically. */
  now(): Date;
}

/**
 * Load the item, as the verifier needs it.
 *
 * `claimedAt` is the transition INTO the verifying state — the moment completion was claimed. An
 * item without one has had no completion claimed, and there is nothing to verify yet.
 */
async function loadItem(
  store: VerificationStore,
  company: string,
  itemId: string,
): Promise<ItemUnderVerification | null> {
  const row = await store.loadItem(company, itemId);
  if (!row || row.claimedAt == null) return null;

  return {
    id: row.id,
    companyId: row.companyId,
    department: row.department as Department,
    kind: row.kind,
    subjectTable: row.subjectTable,
    subjectId: row.subjectId,
    state: row.state,
    evidenceGeneration: await store.evidenceGeneration(company, itemId),
    claimedAt: row.claimedAt,
  };
}

export interface VerificationRunResult extends VerificationResult {
  /** True only when the lifecycle actually moved. */
  readonly transitioned: boolean;
}

/**
 * Verify one item and, when the conclusion warrants it, move the lifecycle.
 *
 * The transition goes through `r1_draft_transition_item()`, which takes the item FOR UPDATE and
 * re-checks the from-state. Two concurrent verifications therefore serialise: the second sees the
 * first's committed state and its transition is refused, so the item cannot end in two terminal
 * outcomes at once.
 */
export async function verifyManagementOutcome(
  env: VerificationEnvironment,
  input: { companyId: string; itemId: string; actorId: string | null; sweep: SweepState },
): Promise<VerificationRunResult> {
  const { store } = env;

  const item = await loadItem(store, input.companyId, input.itemId);
  if (!item) {
    return {
      ...result("unavailable", "the item is not available, or no completion has been claimed"),
      transitioned: false,
    };
  }

  const read =
    item.subjectTable === "tasks"
      ? await store.readTask(input.companyId, item.subjectId)
      : ({ ok: false, reason: `no reader for ${item.subjectTable}` } as Awaited<
          ReturnType<VerificationStore["readTask"]>
        >);

  const verdict = verifyOutcome({
    item,
    companyId: input.companyId,
    // Re-derived from the item's OWN row, not from anything a caller said.
    observed: { subjectTable: item.subjectTable, subjectId: item.subjectId },
    evidenceGenerationNow: await store.evidenceGeneration(input.companyId, input.itemId),
    sweep: input.sweep,
    read,
    now: env.now(),
  });

  if (!verdict.transitionTo) return { ...verdict, transitioned: false };

  // The actor TYPE must describe who actually concluded this.
  //
  // A scheduled sweep passes no actor, and writing it as 'user' would make a machine conclusion
  // indistinguishable from a person's in the transition log — which is the log the learning fold
  // reads to decide whether an outcome is evidence about someone. A `reopened` written that way
  // would score -1 against the assigned person for a condition that merely persists.
  //
  // Two guards in the fold would still have caught it (`deciderType !== 'user'` and `!deciderId`),
  // but a record that is true only because something downstream compensates is not a true record.
  const actorType = input.actorId ? "user" : "system";
  const moved = await store.transition(input.companyId, {
    itemId: item.id,
    from: item.state,
    to: verdict.transitionTo,
    actorId: input.actorId,
    actorType,
    detail: verdict.detail,
  });

  return { ...verdict, transitioned: moved };
}
