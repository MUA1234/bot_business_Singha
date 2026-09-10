/**
 * Role boundaries: assignee, advisor, delegate, external consultant (R2B checkpoint 3).
 *
 * The owner requires these four to stay DISTINCT. They are not four labels on the same thing —
 * they differ in exactly one respect each, and conflating any two of them leaks authority:
 *
 *   assignee            is ACCOUNTABLE for delivery
 *   advisor             owns NOTHING. Guidance only: no delivery, no authority, no accountability.
 *                       An advisor recommendation that quietly carries a ceiling is a promotion
 *                       nobody approved.
 *   delegate            exercises authority that was EXPLICITLY lent, bounded by scope, start and
 *                       expiry, and never wider than the delegator's own (see delegation-scope.ts)
 *   external_consultant works to an approved scope with NO internal company access whatsoever.
 *                       *"No external consultant receives internal-company access merely because
 *                       they are recommended."*
 *
 * These are assertions rather than filters. A candidate that reaches here carrying the wrong
 * shape is a bug in a loader or in the resolver, and quietly correcting it would hide the bug
 * while leaving whatever produced it in place.
 */
import type { EligibleCandidate } from "./candidate";

export class RoleBoundaryViolation extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RoleBoundaryViolation";
  }
}

/**
 * Check one resolved candidate against the boundary of the role it is being offered for.
 *
 * Called on every candidate the resolver is about to return, so a violation cannot reach a UI,
 * an audit record or a manager's decision.
 */
export function assertRoleBoundaries(c: EligibleCandidate): void {
  switch (c.role) {
    case "advisor":
      // An advisor owns nothing. No delegated authority may ride along with the recommendation.
      if (c.delegationScope !== null) {
        throw new RoleBoundaryViolation(
          "advisor_carries_delegation",
          `advisor ${c.membershipId} was resolved carrying a delegation; an advisor supplies guidance and holds no authority`,
        );
      }
      break;

    case "delegate":
      // A delegate without a scope is not a delegate — it is an unbounded grant.
      if (c.delegationScope === null) {
        throw new RoleBoundaryViolation(
          "delegate_without_scope",
          `delegate ${c.membershipId} was resolved without a delegation scope; scope, start and expiry are all required`,
        );
      }
      if (!c.delegationScope.startsAt || !c.delegationScope.endsAt) {
        throw new RoleBoundaryViolation(
          "delegate_without_window",
          `delegate ${c.membershipId} has a delegation with no start or expiry`,
        );
      }
      break;

    case "external_consultant": {
      if (c.engagementScope === null) {
        throw new RoleBoundaryViolation(
          "consultant_without_engagement",
          `external consultant ${c.membershipId} was resolved without an approved engagement scope`,
        );
      }
      if ((c.engagementScope as { internalAccess: boolean }).internalAccess === true) {
        throw new RoleBoundaryViolation(
          "consultant_internal_access",
          `external consultant ${c.membershipId} was resolved carrying internal company access`,
        );
      }
      // Being RECOMMENDED grants nothing. A consultant must hold no internal capability and no
      // delegated authority — either would make a recommendation into an access decision.
      if (c.relevantCapabilities.length > 0) {
        throw new RoleBoundaryViolation(
          "consultant_holds_capability",
          `external consultant ${c.membershipId} was resolved holding internal capabilities ` +
            `(${c.relevantCapabilities.join(", ")}); recommendation is not authorisation`,
        );
      }
      if (c.delegationScope !== null) {
        throw new RoleBoundaryViolation(
          "consultant_holds_delegation",
          `external consultant ${c.membershipId} was resolved carrying a delegation`,
        );
      }
      break;
    }

    case "assignee":
      // The accountable role. A delegation is not a way to become accountable for delivery.
      if (c.candidateType === "external_consultant") {
        throw new RoleBoundaryViolation(
          "consultant_as_assignee",
          `external consultant ${c.membershipId} cannot be the accountable assignee; accountability stays inside the company`,
        );
      }
      break;
  }
}

/** A short label for the explanation surface, so the four roles read differently to a human. */
export function roleLabel(role: EligibleCandidate["role"]): string {
  switch (role) {
    case "assignee": return "Accountable for delivery";
    case "advisor": return "Advises only — owns no delivery and holds no authority";
    case "delegate": return "Exercises delegated authority, within scope and until expiry";
    case "external_consultant": return "External, working to an approved scope with no internal access";
  }
}
