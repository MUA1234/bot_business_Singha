/**
 * Which resource roles a piece of work actually needs (R2C).
 *
 * The owner's rule: *"Determine required resource roles from evidence and the catalogue
 * action — not from arbitrary model output."*
 *
 * So this is a pure function of a REGISTERED catalogue entry and the observation's own
 * structured facts. There is no parameter through which an interpretation could ask for a
 * delegate, and no branch that reads free text. A model can influence WHICH catalogue entry is
 * proposed — that was already true and already constrained — and nothing else.
 *
 * ── Mandatory versus optional, and why the distinction is load-bearing ──────────────────────
 *
 * The owner: *"A missing advisor must not invalidate an otherwise valid assignee unless the
 * action genuinely requires specialist advice."*
 *
 * So a role requirement carries `mandatory`. An OPTIONAL role that finds nobody records its own
 * truthful needs_routing snapshot and leaves the assignee recommendation standing. A MANDATORY
 * role that finds nobody means the work cannot proceed as proposed, and the item says so.
 * Collapsing the two would either block ordinary work for want of an adviser nobody needs, or
 * let genuinely specialist work go ahead unadvised — and those are opposite failures.
 */
import type { CandidateRole } from "./candidate";
import type { Observation } from "../observation";
import type { DomainAction } from "../types";

/**
 * Role declarations attached to a catalogue entry.
 *
 * Every field is OPTIONAL and every default is the conservative one: no team, no advisor, no
 * delegate, no consultant. An action that says nothing gets an assignee and nothing else.
 */
export interface ActionRoleSpec {
  /** The business domain, for advisor and delegation matching ('finance', 'legal', 'hr'…). */
  domain?: string;
  /** Skills the work MANDATES. Only a VERIFIED skill can satisfy one. */
  requiredVerifiedSkills?: readonly string[];
  /** Skills that help but never exclude. */
  preferredSkills?: readonly string[];
  /** A language, ONLY when the work genuinely requires it. */
  requiredLanguage?: "en" | "si" | "ta";
  /** Minimum team size. Absent or 1 means a single assignee. */
  teamOfAtLeast?: number;
  /** Capabilities a TEAM must cover between them. */
  teamMustCover?: readonly string[];
  /** True only where the work genuinely requires specialist advice. */
  requiresAdvisor?: boolean;
  /** True where an advisor is useful but the work is valid without one. */
  advisorHelpful?: boolean;
  /** True where the authority this work needs may legitimately be exercised by a delegate. */
  mayProposeDelegate?: boolean;
  /** True only where the work has been opened to approved external providers. */
  mayUseExternalConsultant?: boolean;
}

/** A catalogue entry that may carry role declarations. */
export type ActionWithRoles = DomainAction & { roles?: ActionRoleSpec };

export interface RoleRequirement {
  role: CandidateRole;
  /**
   * When true, the work cannot proceed as proposed without this role. When false, an empty
   * result is recorded truthfully and everything else stands.
   */
  mandatory: boolean;
  /** Why this role is being asked for. Rendered to the human; never free model text. */
  reason: string;
  /** Minimum number of people, for a team. */
  minimum?: number;
}

/**
 * The roles this action needs.
 *
 * ASSIGNEE IS ALWAYS FIRST AND ALWAYS MANDATORY. Every piece of work needs someone accountable
 * for delivery; that is what makes it work rather than a wish.
 */
export function requiredRolesFor(action: ActionWithRoles, o: Observation): RoleRequirement[] {
  const spec = action.roles ?? {};
  const out: RoleRequirement[] = [];

  const teamSize = spec.teamOfAtLeast ?? 1;
  if (teamSize > 1) {
    out.push({
      role: "assignee",
      mandatory: true,
      minimum: teamSize,
      reason: `this action requires a team of at least ${teamSize}, with one accountable lead`,
    });
  } else {
    out.push({ role: "assignee", mandatory: true, reason: "someone must be accountable for delivery" });
  }

  // ── Advisor. Mandatory ONLY where the action declares that it genuinely needs specialist
  //    advice. `advisorHelpful` produces an OPTIONAL requirement, which is the case the owner
  //    was protecting: useful to have, never a reason to block the work.
  if (spec.requiresAdvisor) {
    out.push({
      role: "advisor",
      mandatory: true,
      reason: "this action genuinely requires specialist advice before it proceeds",
    });
  } else if (spec.advisorHelpful || isHighStakes(o)) {
    out.push({
      role: "advisor",
      mandatory: false,
      reason: spec.advisorHelpful
        ? "advice would help here, but the work is valid without it"
        : "the observation is critical, so advice is offered — it does not block the work",
    });
  }

  // ── Delegate. NEVER mandatory. A delegate is an alternative route to authority somebody
  //    already holds; requiring one would mean work stalls unless authority has been lent.
  if (spec.mayProposeDelegate && action.authorityFloor !== "automatic") {
    out.push({
      role: "delegate",
      mandatory: false,
      reason: `this action needs ${action.authorityFloor}, which an existing delegation may already cover`,
    });
  }

  // ── External consultant. Only where the action has been OPENED to them, and never mandatory:
  //    the work must remain doable in-house.
  if (spec.mayUseExternalConsultant) {
    out.push({
      role: "external_consultant",
      mandatory: false,
      reason: "this action has been opened to approved external providers",
    });
  }

  return out;
}

/**
 * Is this observation high-stakes enough to offer advice unprompted?
 *
 * Read from STRUCTURED fields the detector set — severity and priority — never from a summary
 * string. It only ever produces an OPTIONAL advisor, so the worst case is an extra suggestion a
 * manager ignores.
 */
function isHighStakes(o: Observation): boolean {
  return o.severity === "critical" || o.priority === "critical";
}

/** The role spec for an action, with every conservative default filled in. */
export function roleSpecOf(action: ActionWithRoles): Required<Pick<ActionRoleSpec,
  "requiredVerifiedSkills" | "preferredSkills" | "teamMustCover">> & ActionRoleSpec {
  const spec = action.roles ?? {};
  return {
    ...spec,
    requiredVerifiedSkills: spec.requiredVerifiedSkills ?? [],
    preferredSkills: spec.preferredSkills ?? [],
    teamMustCover: spec.teamMustCover ?? [],
  };
}
