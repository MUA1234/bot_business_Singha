/**
 * Candidate contracts for people intelligence and capability routing (R2B).
 *
 * FOUR ROLES, KEPT DISTINCT, because the owner requires it and because conflating them is how
 * authority leaks:
 *
 *   assignee            accountable for delivery
 *   advisor             supplies guidance and owns NOTHING — no delivery, no authority
 *   delegate            temporarily exercises authority EXPLICITLY delegated, bounded and dated
 *   external_consultant an approved external provider working to a defined scope, with NO
 *                       internal company access of any kind
 *   team                a group proposed for work, resolved from its members
 *
 * A candidate is never "a person we like for this". It is a person or provider that PASSED every
 * hard gate, carrying the evidence for each answer and the list of what we do not know.
 */
import type { AuthorityLevel } from "@/schemas/management";
import type { Department } from "../types";
import { absent, type Fact } from "./evidence";
import { assertNoProtectedAttributes } from "./protected";

export type CandidateType = "staff" | "team" | "advisor" | "delegate" | "external_consultant";

/** What the resolver is being asked to fill. One request may ask for several. */
export type CandidateRole = "assignee" | "advisor" | "delegate" | "external_consultant";

/** Availability as computed by the existing SCH-003 module. */
export interface AvailabilitySignal {
  available: boolean;
  onLeave: boolean;
  availableHours: number;
  capacityStatus: "overloaded" | "healthy" | "underallocated";
}

/** Delegation scope, as stored in `delegations` (migrations 0010 + 0023). */
export interface DelegationScope {
  delegationId: string;
  fromMembership: string;
  domain: string | null;
  maxAmount: string | null;
  currency: string | null;
  startsAt: string;
  endsAt: string;
}

/** The boundary an external consultant works inside. Never a capability, never a membership. */
export interface EngagementScope {
  /** Business domains the engagement covers. Empty means NO approved scope. */
  domains: string[];
  /** Free of internal access by construction: a consultant reads nothing internal. */
  internalAccess: false;
  endsAt: string | null;
}

/**
 * Everything the resolver may know about one candidate.
 *
 * Every field is a {@link Fact}, so provenance travels with the value and a self-declared skill
 * can never be mistaken for a verified one. Construct via {@link candidateEvidence}, which runs
 * the protected-attribute guard.
 */
export interface CandidateEvidence {
  membershipId: string;
  companyId: string;
  candidateType: CandidateType;

  active: Fact<boolean>;
  roles: Fact<string[]>;
  capabilities: Fact<string[]>;
  authorityLevel: Fact<AuthorityLevel>;
  authorityCeiling: Fact<{ amount: string; currency: string }>;
  departmentIds: Fact<string[]>;

  /** `employee_profiles.skills` — self-declared or manager-entered. NEVER verified today. */
  declaredSkills: Fact<string[]>;
  /** No verified-skill source exists in this schema. Absent until one does (F-R2B-2). */
  verifiedSkills: Fact<string[]>;
  /** No staff language source exists in this schema. Absent until one does. */
  languages: Fact<string[]>;

  available: Fact<AvailabilitySignal>;
  openAssignments: Fact<number>;

  /** Delegates only. */
  delegationScope: Fact<DelegationScope>;

  /** External consultants only. */
  providerId: Fact<string>;
  providerStatus: Fact<"verified" | "warning" | "blocked">;
  engagementScope: Fact<EngagementScope>;
}

/** Field defaults — everything absent until a loader supplies it. */
function emptyEvidence(): Omit<CandidateEvidence, "membershipId" | "companyId" | "candidateType"> {
  return {
    active: absent(), roles: absent(), capabilities: absent(), authorityLevel: absent(),
    authorityCeiling: absent(), departmentIds: absent(),
    declaredSkills: absent(), verifiedSkills: absent(), languages: absent(),
    available: absent(), openAssignments: absent(),
    delegationScope: absent(),
    providerId: absent(), providerStatus: absent(), engagementScope: absent(),
  };
}

/**
 * Build candidate evidence, refusing any protected or unapproved attribute.
 *
 * The guard runs HERE — at construction — so an attribute that should never have been loaded
 * cannot sit in memory waiting to be used by mistake.
 */
export function candidateEvidence(
  identity: { membershipId: string; companyId: string; candidateType: CandidateType },
  supplied: Partial<Omit<CandidateEvidence, "membershipId" | "companyId" | "candidateType">> &
    Record<string, unknown> = {},
): CandidateEvidence {
  assertNoProtectedAttributes(supplied, `candidate evidence for ${identity.membershipId}`);
  // IDENTITY IS APPLIED LAST, and that ordering is the point (defect R2B-F-002). Identity keys
  // are legitimately on the permitted-signal allowlist, so the guard lets them through — which
  // meant a loader that put `companyId` or `membershipId` in `supplied` silently REPLACED the
  // authorised identity. The company binding is the least of it: a replaced membershipId makes
  // the outcome-history lookup fetch a DIFFERENT PERSON's record. The caller's identity wins.
  return { ...emptyEvidence(), ...(supplied as object), ...identity } as CandidateEvidence;
}

/**
 * What the work needs. Suitability is answered against THIS — the owner forbids a universal
 * employee rank, so there is no method here that scores a person without a request.
 */
export interface CandidateRequest {
  companyId: string;
  department: Department;
  /** The kind of work, e.g. "finance.receivable_followup". Signals are keyed on it. */
  taskKind: string;
  roles: CandidateRole[];

  requiredCapability: string | null;
  requiredAuthority: AuthorityLevel;
  /** The money ceiling the holder must have, when the work commits money. */
  authorityAmount: { amount: string; currency: string } | null;
  /** The business domain, for delegation matching ('expense', 'payment', 'hr'...). */
  authorityDomain: string | null;

  /** Skills the work MANDATES. Only a VERIFIED skill can satisfy one (F-R2B-2). */
  requiredVerifiedSkills: string[];
  /** Skills that help but are not mandatory. Never used to exclude. */
  preferredSkills: string[];
  /**
   * A language, ONLY when the task genuinely requires it (owner rule). Null on every other
   * task, and when null, language may not influence ranking at all.
   */
  requiredLanguage: string | null;

  /** The date the work would start, for the leave check. */
  onDateIso: string;
  estimateHours: number | null;
  now: Date;

  /** Who raised the work — separation of duties. */
  raisedByMembershipId?: string | null;
  /** External consultants are considered ONLY when the caller explicitly allows them. */
  allowExternalConsultants?: boolean;
}

/** A machine-readable reason. Free prose is never the primary reason — the UI renders from this. */
export interface Reason {
  code: string;
  detail: string;
  evidence?: { table: string; id: string } | null;
}

/** One candidate that passed every hard gate. */
export interface EligibleCandidate {
  membershipId: string;
  candidateType: CandidateType;
  /** The role this candidate is offered FOR. */
  role: CandidateRole;

  relevantCapabilities: string[];
  /** Skills matched, each carrying whether it was verified. */
  relevantSkills: Array<{ skill: string; verified: boolean }>;

  availability: AvailabilitySignal | null;
  /** 0..1 — how much the evidence supports this recommendation, NOT how good the person is. */
  confidence: number;
  /** Ordering within the response. Never persisted, never a person-level score. */
  suitability: number;

  evidenceRefs: Array<{ table: string; id: string }>;
  reasons: Reason[];
  missingInformation: Reason[];
  requiresHumanReview: Reason[];

  /** Delegates and consultants carry their boundary; everyone else carries null. */
  delegationScope: DelegationScope | null;
  engagementScope: EngagementScope | null;
}

/** A candidate that was considered and refused, kept so the human can see who was excluded and why. */
export interface RejectedCandidate {
  membershipId: string;
  candidateType: CandidateType;
  reasons: Reason[];
  /**
   * True when exclusion is a NEUTRAL circumstance — approved leave, authorised training, an
   * accommodation, or simply missing data. The owner forbids penalising any of these, so a
   * neutral exclusion must never become a learning signal or a mark against the person.
   */
  neutral: boolean;
}

/** The resolver's answer. */
export interface CandidateResolution {
  companyId: string;
  taskKind: string;
  outcome: "candidates" | "needs_routing";
  candidates: EligibleCandidate[];
  rejected: RejectedCandidate[];
  /** Populated when `outcome` is `needs_routing`, with a precise reason. */
  routing: { department: Department; reasonCode: string; detail: string } | null;
  /** Aggregate gaps in the evidence, for the explanation surface. */
  missingInformation: Reason[];
  /** Always true: a human makes the assignment. Present so no caller can assume otherwise. */
  humanDecisionRequired: true;
  /** The signal rule version used, so a recommendation can be reproduced and challenged. */
  signalRuleVersion: string;
}
