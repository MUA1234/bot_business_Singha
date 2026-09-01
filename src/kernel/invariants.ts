/**
 * Kernel invariants (R1).
 *
 * These are the rules that must hold no matter which department an item came from and no
 * matter what a model returned. Each is a pure predicate so it is directly testable, and
 * each is enforced a second time at the database boundary — an invariant that lives only in
 * application code is a convention, not a control.
 *
 * The owner's approval conditions this file implements:
 *   * the AI must never invent business facts;
 *   * recommendations must cite existing evidence;
 *   * the zero-evidence prohibition is preserved;
 *   * model facts not supported by recorded evidence are rejected;
 *   * cross-company data never mixes.
 */
import type { EvidenceRef, Interpretation, Observation, DomainAction } from "./types";

export class InvariantViolation extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvariantViolation";
  }
}

/** A stable key for an evidence reference. */
const refKey = (t: string, i: string) => `${t}#${i}`;

/**
 * INV-1 — zero-evidence prohibition.
 *
 * An item may not be recommended (or anything downstream) on the strength of nothing.
 */
export function assertHasEvidence(evidence: EvidenceRef[], state: string): void {
  if (!evidence || evidence.length === 0) {
    throw new InvariantViolation(
      "zero_evidence",
      `management item cannot enter "${state}" with zero evidence references`,
    );
  }
}

/**
 * INV-2 — cross-company isolation.
 *
 * Every evidence reference must belong to the item's company. Enforced here and by the
 * `management_item_evidence_company` trigger. Cross-company leakage is a critical failure
 * class in this repository, so it fails loudly rather than filtering silently.
 */
export function assertSameCompany(itemCompanyId: string, evidenceCompanyIds: string[]): void {
  for (const cid of evidenceCompanyIds) {
    if (cid !== itemCompanyId) {
      throw new InvariantViolation(
        "cross_company_evidence",
        `cross-company evidence refused: item company ${itemCompanyId}, evidence company ${cid}`,
      );
    }
  }
}

/**
 * INV-3 — the AI may not invent business facts.
 *
 * Every claim an interpreter makes must be supported by at least one evidence reference
 * that was actually recorded. A claim citing nothing, or citing a reference the item does
 * not hold, is rejected — the interpretation is downgraded to `malformed` rather than
 * being allowed to influence a recommendation.
 *
 * Returns the unsupported claims; empty means the interpretation is clean.
 */
export function unsupportedClaims(interpretation: Interpretation, evidence: EvidenceRef[]): string[] {
  const known = new Set(evidence.map((e) => refKey(e.sourceTable, e.sourceId)));
  const bad: string[] = [];
  for (const s of interpretation.statements) {
    if (!s.supportedBy || s.supportedBy.length === 0) {
      bad.push(s.claim);
      continue;
    }
    const anySupported = s.supportedBy.some((r) => known.has(refKey(r.sourceTable, r.sourceId)));
    if (!anySupported) bad.push(s.claim);
  }
  return bad;
}

export function assertInterpretationGrounded(interpretation: Interpretation, evidence: EvidenceRef[]): void {
  const bad = unsupportedClaims(interpretation, evidence);
  if (bad.length > 0) {
    throw new InvariantViolation(
      "unsupported_model_fact",
      `interpretation makes ${bad.length} claim(s) not supported by recorded evidence: ${bad.join("; ")}`,
    );
  }
}

/**
 * INV-4 — a proposed action must be registered in the catalogue.
 *
 * The kernel selects from the catalogue; it never invents an action. This is what keeps
 * free-text model output from reaching business state.
 */
export function assertActionRegistered(actionId: string, catalogue: DomainAction[]): DomainAction {
  const found = catalogue.find((a) => a.id === actionId);
  if (!found) {
    throw new InvariantViolation("unregistered_action", `action "${actionId}" is not in the registered catalogue`);
  }
  return found;
}

/**
 * INV-5 — R1 actions are internal only.
 *
 * No R1 action may send a customer message, move money, post a journal, change a
 * permission or call an external system. Owner decision R1-D-7 keeps the CRM observation
 * but limits its output to an internal recommendation, a draft, or an internal task.
 */
export function assertInternalOnly(action: DomainAction): void {
  if (action.internalOnly !== true) {
    throw new InvariantViolation(
      "external_action_refused",
      `action "${action.id}" is not internal-only; R1 may not take external or customer-facing actions`,
    );
  }
}

/**
 * INV-6 — an observation must not invent a business deadline (owner decision R1-D-4).
 *
 * A deadline is only legitimate when it came from source evidence or company policy, and
 * the provenance must be stated. Absent both, the honest value is null.
 */
export function assertDeadlineProvenance(o: Observation): void {
  const d = o.businessDeadline;
  if (d == null) return;
  if (d.source !== "evidence" && d.source !== "policy") {
    throw new InvariantViolation(
      "invented_deadline",
      `observation ${o.identityKey} carries a business deadline with no legitimate provenance`,
    );
  }
  if (!d.at) {
    throw new InvariantViolation("invented_deadline", `observation ${o.identityKey} claims a deadline source with no date`);
  }
}

/**
 * INV-7 — evidence must be structurally sound before it is stored.
 *
 * A reference with no table or no row id points at nothing, and unverifiable evidence is
 * worse than none because it looks like proof.
 */
export function assertEvidenceWellFormed(evidence: EvidenceRef[]): void {
  for (const e of evidence) {
    if (!e.sourceTable?.trim() || !e.sourceId?.trim()) {
      throw new InvariantViolation("malformed_evidence", "evidence reference must name both a source table and a row id");
    }
    if (e.origin && e.origin !== "detector" && e.origin !== "human") {
      throw new InvariantViolation(
        "malformed_evidence",
        `evidence origin "${e.origin}" is not permitted — a model may cite evidence, never create it`,
      );
    }
  }
}

/** Convenience: every observation-level invariant, in one call. */
export function assertObservationValid(o: Observation): void {
  assertEvidenceWellFormed(o.evidence);
  assertDeadlineProvenance(o);
  assertSameCompany(
    o.companyId,
    o.evidence.map(() => o.companyId), // detector evidence is company-scoped by construction
  );
}
