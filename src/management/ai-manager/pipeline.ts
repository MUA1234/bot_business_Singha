/**
 * Observation → plan (Architecture V2 change plan §6.2). Pure and deterministic:
 * turns a validated ManagementObservation into a plan the app can act on SAFELY —
 * concrete tasks to capture, whether human approval is required, and open questions.
 * It decides nothing sensitive: it only ever proposes `captured` tasks (a low-risk
 * informational action) and flags everything else for a human (Constitution §6).
 */
import type { ManagementObservation, AuthorityLevel } from "@/schemas/management";
import {
  applyModelRecommendation,
  resolveRequiredAuthority,
  type AuthorityContext,
  type AuthorityFacts,
} from "@/policy/authority-engine";

export interface PlannedTask {
  title: string;
  note: string | null;
  /** Task requires human evidence to complete when the observation carries risk/impact. */
  requiresEvidence: boolean;
}

export interface ManagerPlan {
  tasks: PlannedTask[];
  requiredAuthority: AuthorityLevel;
  needsApproval: boolean; // anything above policy_controlled
  clarifications: string[]; // missing info to resolve first
  suggestedActions: string[]; // for the human to consider — never auto-run
  confidence: number;
  /** Why this authority level was required — deterministic reasons, for the audit trail. */
  authorityReasons: string[];
  /** True when policy was missing/unknown/conflicting and the engine escalated for that reason. */
  authorityFailedClosed: boolean;
}

/**
 * Which business domain does this observation belong to? Derived from the observation's own
 * structured impact assertions, never from free text the model wrote about authority.
 * Unknown ⇒ "general", which carries no domain floor but also no exemption.
 */
export function inferDomain(o: ManagementObservation): string {
  const i = o.impact ?? {};
  if (stated(i.financial)) return "finance";
  if (stated(i.legal)) return "legal";
  if (stated(i.safety)) return "ops";
  return "general";
}

const APPROVAL_LEVELS = new Set<AuthorityLevel>(["manager_approval", "specialist_approval", "owner_approval"]);

/** The ladder, lowest → highest. Mirrors AuthorityLevel and route-decision's LEVELS. */
const LADDER: AuthorityLevel[] = [
  "automatic",
  "policy_controlled",
  "manager_approval",
  "specialist_approval",
  "owner_approval",
];
const rank = (l: AuthorityLevel) => LADDER.indexOf(l);
const higher = (a: AuthorityLevel, b: AuthorityLevel): AuthorityLevel => (rank(a) >= rank(b) ? a : b);

/**
 * Derive deterministic FACTS from an observation, for the company-scoped authority engine.
 *
 * The distinction that matters: the engine must never be handed the model's `requiredAuthority`.
 * It is handed booleans about whether the observation ASSERTS an impact, which is a fact about the
 * observation, and the engine decides the level from company policy.
 */
export function authorityFactsFrom(o: ManagementObservation, domain: string): AuthorityFacts {
  const i = o.impact ?? {};
  return {
    domain,
    impact: {
      financial: stated(i.financial),
      legal: stated(i.legal),
      safety: stated(i.safety),
      operational: stated(i.operational),
      customer: stated(i.customer),
    },
    confidence: o.confidence,
  };
}

/**
 * Interim authority FLOOR — the FAIL-CLOSED FALLBACK, no longer the primary mechanism.
 *
 * Why this still exists: `requiredAuthority` is a field the MODEL fills in, and the model reads
 * untrusted text. The owner did not accept a hardcoded floor as the permanent implementation —
 * company-scoped `authority_rules` are (see `src/policy/authority-engine.ts`, now wired into
 * `planFromObservation`). This function remains as the fallback for the ONE case the engine cannot
 * answer: when no `AuthorityContext` is available at all. That case must still fail closed rather
 * than fall back to the model's word, so the floor is kept rather than deleted.
 *
 * The floor never LOWERS what the model asked for.
 */
export function authorityFloor(o: ManagementObservation): AuthorityLevel {
  const i = o.impact ?? {};
  let floor: AuthorityLevel = "automatic";

  // Money, legal exposure or safety are specialist matters by policy (CLAUDE.md financial
  // controls, and the same floor the prompt asks the model to apply — now enforced).
  if (stated(i.financial) || stated(i.legal) || stated(i.safety)) floor = higher(floor, "specialist_approval");
  // Anything with a stated operational or customer impact is at least a manager's call.
  if (stated(i.operational) || stated(i.customer)) floor = higher(floor, "manager_approval");
  // A low-confidence reading must never present itself as routine.
  if (o.confidence < 0.3) floor = higher(floor, "manager_approval");

  return floor;
}

/**
 * Is this impact field an actual statement of impact?
 *
 * The impact fields are OPTIONAL free text, and a model asked for optional keys routinely fills
 * them with a placeholder rather than omitting them. Testing raw truthiness would escalate on
 * "none" / "n/a" / "nil" — turning the floor into a permanent alarm and drowning the signal it
 * exists to raise. An over-escalating control is not a safe control; it is an ignored one.
 */
function stated(v: string | null | undefined): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "") return false;
  return !["none", "n/a", "na", "nil", "no", "null", "unknown", "-", "0"].includes(s);
}

/** Any material impact means a completed task should require evidence. */
function hasImpact(o: ManagementObservation): boolean {
  const i = o.impact ?? {};
  return Boolean(i.financial || i.legal || i.operational || i.safety);
}

export function planFromObservation(o: ManagementObservation, authority?: AuthorityContext): ManagerPlan {
  const requiresEvidence = hasImpact(o);
  const tasks: PlannedTask[] = (o.detectedTasks ?? []).map((t) => ({
    title: t.title,
    note: t.note ?? null,
    requiresEvidence,
  }));

  // The model's claim is a PROPOSAL; deterministic policy is the control.
  //
  // With an AuthorityContext the company-scoped engine decides from `authority_rules` and the
  // active approval policy, and the model may only RAISE that result. Without one — the engine
  // cannot be consulted — we fall back to the interim floor, which also only raises. Neither path
  // lets the model's word stand alone, and neither path can lower the deterministic answer.
  let requiredAuthority: AuthorityLevel;
  let authorityReasons: string[] = [];
  let authorityFailedClosed = false;

  if (authority) {
    const resolved = applyModelRecommendation(
      resolveRequiredAuthority(authorityFactsFrom(o, inferDomain(o)), authority),
      o.requiredAuthority,
    );
    requiredAuthority = resolved.level;
    authorityReasons = resolved.reasons;
    authorityFailedClosed = resolved.failedClosed;
  } else {
    requiredAuthority = higher(o.requiredAuthority, authorityFloor(o));
    authorityReasons = ["no company authority context available — interim floor applied (fail-closed fallback)"];
    authorityFailedClosed = true;
  }

  return {
    tasks,
    requiredAuthority,
    needsApproval: APPROVAL_LEVELS.has(requiredAuthority),
    clarifications: o.missingInfo ?? [],
    suggestedActions: o.suggestedActions ?? [],
    confidence: o.confidence,
    authorityReasons,
    authorityFailedClosed,
  };
}
