/**
 * Complementary team formation (R2C).
 *
 * The owner's rule: *"recommend complementary members rather than simply the highest-ranked
 * individuals"*, and *"avoid duplicate responsibility"*.
 *
 * That is a different algorithm from "take the top N", and the difference matters. Taking the
 * top N gives you five people who are all good at the same thing and nobody who can do the rest
 * — which is the failure mode of every ranking-based staffing tool. This picks for COVERAGE:
 * at each step it adds whoever contributes the most capability the team does not yet have, and
 * only falls back to ordering when nothing new is on offer.
 *
 * ── What it will not do ─────────────────────────────────────────────────────────────────────
 *
 * It proposes ONE accountable lead. A team with two leads has no lead — responsibility that is
 * shared is responsibility that is deniable — and a team with none is a group of people who all
 * assume someone else is dealing with it.
 *
 * It reports what it CANNOT cover. A team recommendation that quietly omits a required
 * capability is worse than no recommendation, because it looks complete.
 *
 * Nothing here assigns anyone. It orders and groups; a human forms the team.
 */
import type { EligibleCandidate } from "./candidate";

export interface TeamProposal {
  /** The proposed members, lead first. */
  members: EligibleCandidate[];
  /**
   * The one person proposed as accountable. Null when no member qualifies to lead, which is
   * reported rather than papered over by promoting whoever happened to rank first.
   */
  lead: EligibleCandidate | null;
  /** Why there is no lead, when there is none. */
  leadReason: string | null;
  /** Capabilities the team covers between them. */
  covered: string[];
  /** Required capabilities NOBODY on the team holds. */
  missingCapabilities: string[];
  /** True when the team is smaller than the action asked for. */
  understaffed: boolean;
  requestedMinimum: number;
  reasons: Array<{ code: string; detail: string }>;
}

export interface TeamRequest {
  /** How many people the action asked for. */
  minimum: number;
  /** Capabilities the team must cover BETWEEN THEM — not each. */
  mustCover: readonly string[];
  /** The capability a LEAD must personally hold, when the action names one. */
  leadCapability: string | null;
}

/**
 * Build a complementary team from candidates that have ALREADY passed every hard gate.
 *
 * Only eligible people reach here, so nothing in this file re-checks leave, capacity, company or
 * capability eligibility — that would be a second implementation of rules that already have one.
 */
export function formTeam(
  eligible: readonly EligibleCandidate[],
  req: TeamRequest,
): TeamProposal {
  const reasons: Array<{ code: string; detail: string }> = [];

  if (eligible.length === 0) {
    return {
      members: [], lead: null,
      leadReason: "no eligible candidate was available to form a team",
      covered: [], missingCapabilities: [...req.mustCover],
      understaffed: true, requestedMinimum: req.minimum,
      reasons: [{ code: "no_eligible_members", detail: "nobody passed the eligibility gates" }],
    };
  }

  // ── Greedy by MARGINAL COVERAGE. At each step take whoever adds the most capability the team
  //    does not already have. Ties fall back to the resolver's own order, which is already
  //    deterministic — so the whole selection is reproducible.
  const remaining = [...eligible];
  const chosen: EligibleCandidate[] = [];
  const covered = new Set<string>();
  const needed = new Set(req.mustCover);

  while (chosen.length < req.minimum && remaining.length > 0) {
    let bestIndex = 0;
    let bestGain = -1;

    for (let i = 0; i < remaining.length; i++) {
      const gain = remaining[i]!.relevantCapabilities.filter((c) => needed.has(c) && !covered.has(c)).length;
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = i;
      }
    }

    const picked = remaining.splice(bestIndex, 1)[0]!;
    chosen.push(picked);
    for (const c of picked.relevantCapabilities) covered.add(c);

    if (bestGain > 0) {
      reasons.push({
        code: "added_for_coverage",
        detail: `${picked.membershipId} adds ${bestGain} capability the team did not have`,
      });
    } else {
      // NOBODY LEFT ADDS ANYTHING NEW. Say so, rather than silently padding the team with
      // people who duplicate work already covered.
      reasons.push({
        code: "added_without_new_coverage",
        detail: `${picked.membershipId} adds no capability the team lacks; added only to reach the requested size`,
      });
    }
  }

  const missing = [...needed].filter((c) => !covered.has(c)).sort();
  if (missing.length > 0) {
    reasons.push({
      code: "coverage_incomplete",
      detail: `no proposed member holds ${missing.join(", ")}`,
    });
  }

  const { lead, leadReason } = chooseLead(chosen, req);
  if (lead) {
    reasons.push({ code: "lead_proposed", detail: `${lead.membershipId} is proposed as accountable lead` });
  } else {
    reasons.push({ code: "no_lead", detail: leadReason ?? "no member qualifies to lead" });
  }

  const understaffed = chosen.length < req.minimum;
  if (understaffed) {
    reasons.push({
      code: "understaffed",
      detail: `${chosen.length} eligible of the ${req.minimum} requested`,
    });
  }

  // The lead is listed FIRST, so the accountable person is unmissable wherever the team is read.
  const members = lead ? [lead, ...chosen.filter((c) => c !== lead)] : chosen;

  return {
    members,
    lead,
    leadReason: lead ? null : leadReason,
    covered: [...covered].sort(),
    missingCapabilities: missing,
    understaffed,
    requestedMinimum: req.minimum,
    reasons,
  };
}

/**
 * Choose the accountable lead.
 *
 * When the action names a lead capability, ONLY someone who personally holds it may lead —
 * being the best-ranked person on a team does not confer a capability. When it names none, the
 * first member in the resolver's order leads, which is deterministic and explainable.
 *
 * Returning NO LEAD is a legitimate answer and is reported. The alternative — promoting whoever
 * happened to sort first — would manufacture accountability nobody has agreed to.
 */
function chooseLead(
  members: readonly EligibleCandidate[],
  req: TeamRequest,
): { lead: EligibleCandidate | null; leadReason: string | null } {
  if (members.length === 0) {
    return { lead: null, leadReason: "the team is empty" };
  }
  if (!req.leadCapability) {
    return { lead: members[0]!, leadReason: null };
  }
  const qualified = members.find((m) => m.relevantCapabilities.includes(req.leadCapability!));
  if (!qualified) {
    return {
      lead: null,
      leadReason:
        `no proposed member holds ${req.leadCapability}, which this work requires of an accountable lead`,
    };
  }
  return { lead: qualified, leadReason: null };
}
