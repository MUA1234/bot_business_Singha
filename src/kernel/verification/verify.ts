/**
 * The verification boundary.
 *
 * Every precondition in the owner's contract is checked here, in one place, before any domain rule
 * is consulted — so a rule cannot be reached with a stale item, a foreign company, a failed sweep
 * or an observation taken before the thing it is meant to verify.
 *
 * The order is not cosmetic. Each check answers a question that makes the next one meaningful:
 * there is no point asking "is the condition gone" about a record we may not read, in a company
 * that is not this one, using a sweep that did not finish.
 */
import type { Department } from "../types";
import type { TaskUnderVerification } from "./rules";
import {
  result,
  type ItemUnderVerification,
  type SourceRead,
  type SweepState,
  type VerificationResult,
} from "./contract";
import { ruleFor } from "./rules";

export interface VerificationInput {
  readonly item: ItemUnderVerification;
  /** The company the CALLER is operating in. Compared with the item's own. */
  readonly companyId: string;
  /** The originating identity as re-derived now, from the item's own row. */
  readonly observed: { readonly subjectTable: string; readonly subjectId: string };
  /** The evidence generation as it stands now. */
  readonly evidenceGenerationNow: string;
  readonly sweep: SweepState;
  readonly read: SourceRead<TaskUnderVerification>;
  readonly now: Date;
}

/** States from which a verification conclusion may be drawn at all. */
const VERIFIABLE_STATES = new Set(["verifying", "monitoring"]);

/**
 * Verify one management outcome by re-observation.
 *
 * Returns a result for every path — including the refusals. A refusal is not an error: most
 * verification attempts in a healthy system will conclude `condition_persists` or `unavailable`,
 * and both are useful answers.
 */
export function verifyOutcome(input: VerificationInput): VerificationResult {
  const { item, sweep, now } = input;

  // ── 1. Same company. A verification read from another tenant is not evidence about this one. ──
  if (item.companyId !== input.companyId) {
    return result("unavailable", "the item belongs to a different company");
  }

  // ── 2. Same originating observation identity. ──
  //
  // The item names the record it was raised about. If the read was of a different record — a
  // different table, or a different row — then whatever it found says nothing about this item.
  if (
    item.subjectTable !== input.observed.subjectTable ||
    item.subjectId !== input.observed.subjectId
  ) {
    return result("unavailable", "the verification read was of a different record");
  }

  // ── 3. A state in which a conclusion is meaningful. ──
  if (!VERIFIABLE_STATES.has(item.state)) {
    return result("unavailable", `state "${item.state}" does not admit verification`);
  }

  // ── 4. The evidence generation must still be the one the item was recommended against. ──
  //
  // If the evidence changed underneath, we would be verifying a conclusion drawn from something
  // else — which is the same defect R2E-F-006 found on the execution side.
  if (item.evidenceGeneration !== input.evidenceGenerationNow) {
    return result("unavailable", "the evidence generation changed since the item was raised");
  }

  // ── 5. The observation must be LATER than the claim it is meant to test. ──
  //
  // A read taken before completion was claimed describes the world that prompted the work, not
  // the world after it. This is the check that stops a cached or replayed sweep certifying a
  // result it could not have seen.
  if (!(sweep.observedAt > item.claimedAt)) {
    return result(
      "unavailable",
      "the verification observation is not later than the completion claim",
    );
  }

  // ── 6. The sweep must have finished, and must not have been disturbed. ──
  //
  // A partial, reset, abandoned or truncated sweep cannot support ANY conclusion — least of all a
  // negative one, where "the detector did not raise it" is exactly what a half-finished sweep
  // looks like.
  if (sweep.interrupted) {
    return result("pending_clean_observation", "the source generation was reset or abandoned");
  }
  if (!sweep.complete) {
    return result("pending_clean_observation", "the source sweep did not complete");
  }

  // ── 7. A domain rule that can actually say what resolved means. ──
  const rule = ruleFor(item.department as Department);
  if (!rule) {
    return result(
      "unavailable",
      `no verification rule is registered for the "${item.department}" domain`,
    );
  }
  if (rule.subjectTable !== item.subjectTable) {
    return result(
      "unavailable",
      `the "${item.department}" rule verifies ${rule.subjectTable}, not ${item.subjectTable}`,
    );
  }

  // ── 8. Ask the domain. ──
  return rule.verify({ kind: item.kind, read: input.read, now });
}
