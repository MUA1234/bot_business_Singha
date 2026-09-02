/**
 * Task-specific suitability (R2B).
 *
 * The owner's constraint: *"Do not create a universal employee rank. Suitability must be
 * specific to the particular task and current circumstances."*
 *
 * So there is no function here that takes a person and returns a number. Every function takes a
 * person AND a request, the result is never persisted, and the derived learning signal is keyed
 * on `(company, subject, taskKind)` — the same person legitimately scores differently for
 * chasing a receivable and for a compliance review.
 *
 * ── How missing evidence is handled, and why it is not a penalty ────────────────────────────
 *
 * Everyone starts at a NEUTRAL baseline. Evidence can lift a candidate above it; the ABSENCE of
 * evidence moves nobody. A person nobody has ever assigned work to therefore sits exactly at the
 * baseline, alongside a person whose history is average — they are separated by CONFIDENCE, which
 * is reported honestly, not by rank. That is what makes "do not penalise lack of opportunity"
 * and "do not penalise missing historical data" true rather than aspirational.
 *
 * The learning signal is deliberately ASYMMETRIC: pushing a candidate DOWN requires strictly more
 * evidence than pushing them up (see MIN_OUTCOMES_TO_PROMOTE / MIN_OUTCOMES_TO_DEMOTE). Being
 * unproven and being proven-poor are different claims, and only the second is an adverse one.
 */
import type { CandidateEvidence, CandidateRequest, CandidateRole, Reason } from "./candidate";

/** The role an outcome was earned in. Signals never cross between them. */
export type SignalRole = CandidateRole;
import { isPresent, isVerified, provenanceLabel } from "./evidence";

/**
 * A derived, task-specific outcome signal. Produced by the learning fold
 * (`learning/signals.ts`) and injected here, so suitability has no I/O and no memory.
 */
export interface SuitabilitySignal {
  /** Keyed on the task kind — never on the person alone. */
  taskKind: string;
  /**
   * And on the ROLE the outcome was earned in (R2C).
   *
   * The owner's rule: delivery performance must not automatically become advisor performance,
   * advisor success must not become delegated-authority evidence, and consultant performance
   * stays provider-specific. Those are different jobs. Someone who delivers reliably may advise
   * badly, and someone whose advice is excellent may be a poor choice to hold authority — a
   * system that merges the two is not measuring anything real, it is measuring popularity.
   */
  role: SignalRole;
  membershipId: string;
  /** Outcomes considered at all, before recency and anti-poisoning filtering. */
  outcomeCount: number;
  /**
   * Outcomes a HUMAN CONFIRMED, whether the work stood (verified) or was sent back (reopened).
   *
   * NOT "verified outcomes" — defect R2B-F-005. It was called verifiedOutcomeCount and rendered
   * to managers as "5 verified outcome(s)" on a history of five REOPENED items, which reads as
   * praise for a record of rework. The count is the evidence base, not the good news in it.
   */
  confirmedOutcomeCount: number;
  /** Of the verified outcomes, how many met a recorded business deadline. */
  onTimeCount: number;
  /** How many DISTINCT humans contributed the decisions. One decider is not a consensus. */
  distinctDeciderCount: number;
  /** Recency-weighted success in 0..1, already decayed by the fold. */
  weightedSuccessRate: number;
  /** True when the history contains outcomes that point in opposite directions. */
  contradictory: boolean;
  /** The rule version that produced this, so a recommendation can be challenged and reproduced. */
  ruleVersion: string;
}

/** Minimum evidence before a signal may PROMOTE a candidate. */
export const MIN_OUTCOMES_TO_PROMOTE = 3;
/** Strictly more evidence before a signal may DEMOTE one. Adverse claims need a higher bar. */
export const MIN_OUTCOMES_TO_DEMOTE = 5;
/** At least two distinct deciders, so one manager's opinion is never on its own decisive. */
export const MIN_DECIDERS = 2;

/** The neutral baseline. Everyone starts here; evidence moves them. */
const BASELINE = 0.5;
/**
 * The most the learning signal may ever move a candidate. Deliberately small: outcome history
 * adjusts the ORDER of people who all already passed every hard gate. It can never substitute
 * for a capability, and it can never outweigh availability.
 */
const MAX_LEARNING_SHIFT = 0.15;
/** Preferred (non-mandatory) skills contribute a bounded lift. */
const MAX_SKILL_LIFT = 0.2;
/** Free capacity contributes a bounded lift — the existing "least loaded first" rule, bounded. */
const MAX_CAPACITY_LIFT = 0.15;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export interface SuitabilityResult {
  /** Ordering value for THIS request only. Never stored, never a person-level score. */
  suitability: number;
  /** 0..1 — how well the evidence supports the recommendation, NOT how good the person is. */
  confidence: number;
  reasons: Reason[];
  missingInformation: Reason[];
  requiresHumanReview: Reason[];
  matchedSkills: Array<{ skill: string; verified: boolean }>;
}

/**
 * Score one already-eligible candidate against one request.
 *
 * Only call this for candidates that passed `evaluateEligibility`. Suitability answers "in what
 * order should a human consider these people", never "may this person do this work".
 */
export function scoreSuitability(
  c: CandidateEvidence,
  req: CandidateRequest,
  signal: SuitabilitySignal | null,
  /** The role being resolved. A signal earned in another role is refused (R2C). */
  role?: CandidateRole,
): SuitabilityResult {
  const reasons: Reason[] = [];
  const missingInformation: Reason[] = [];
  const requiresHumanReview: Reason[] = [];
  let score = BASELINE;

  // ── Preferred skills. Non-mandatory, so a self-declared skill MAY contribute — but it is
  //    labelled as unverified everywhere it appears, and it can never satisfy a requirement.
  const matchedSkills: Array<{ skill: string; verified: boolean }> = [];
  if (req.preferredSkills.length > 0) {
    const verified = new Set(isVerified(c.verifiedSkills) ? c.verifiedSkills.value! : []);
    const declared = new Set(isPresent(c.declaredSkills) ? c.declaredSkills.value! : []);
    for (const s of req.preferredSkills) {
      if (verified.has(s)) matchedSkills.push({ skill: s, verified: true });
      else if (declared.has(s)) matchedSkills.push({ skill: s, verified: false });
    }
    if (matchedSkills.length > 0) {
      // A verified skill counts double a self-declared one — the only place provenance affects
      // ordering rather than eligibility.
      const weight = matchedSkills.reduce((sum, m) => sum + (m.verified ? 1 : 0.5), 0);
      const lift = MAX_SKILL_LIFT * Math.min(1, weight / req.preferredSkills.length);
      score += lift;
      reasons.push({
        code: "preferred_skills_matched",
        detail: matchedSkills
          .map((m) => `${m.skill} (${m.verified ? "verified" : "self-declared, unverified"})`)
          .join(", "),
        evidence: (matchedSkills.some((m) => m.verified) ? c.verifiedSkills.sourceRef : c.declaredSkills.sourceRef) ?? null,
      });
    }
    if (!isPresent(c.declaredSkills) && !isVerified(c.verifiedSkills)) {
      missingInformation.push({
        code: "no_skill_record",
        detail: "no skills are recorded for this person, so skill fit could not be assessed",
        evidence: null,
      });
    }
  }

  // ── Free capacity. About the schedule, not the person: it changes weekly and is never history.
  if (isPresent(c.available) && c.available.evidenceClass !== "stale") {
    const a = c.available.value!;
    const headroom = req.estimateHours && req.estimateHours > 0
      ? clamp01(a.availableHours / (req.estimateHours * 2))
      : clamp01(a.availableHours / 40);
    score += MAX_CAPACITY_LIFT * headroom;
    reasons.push({
      code: "capacity_headroom",
      detail: `${a.availableHours}h free this week (${a.capacityStatus})`,
      evidence: c.available.sourceRef,
    });
  } else {
    missingInformation.push({
      code: "capacity_unknown",
      detail:
        c.available.evidenceClass === "stale"
          ? "the capacity snapshot is out of date, so current workload is unknown"
          : "current workload is not recorded",
      evidence: null,
    });
  }

  // ── Learning. Bounded, asymmetric, and only above the evidence thresholds.
  const learning = applyLearningSignal(signal, req, role);
  score += learning.shift;
  reasons.push(...learning.reasons);
  missingInformation.push(...learning.missing);
  requiresHumanReview.push(...learning.review);

  // ── Confidence. How well-attested is this recommendation? Never a judgement of the person.
  const confidence = computeConfidence(c, req, signal, missingInformation.length);
  if (confidence < 0.5) {
    requiresHumanReview.push({
      code: "low_confidence",
      detail: "the evidence for this recommendation is thin; a human should choose on other grounds",
      evidence: null,
    });
  }

  return {
    suitability: clamp01(score),
    confidence,
    reasons,
    missingInformation,
    requiresHumanReview,
    matchedSkills,
  };
}

interface LearningApplication {
  shift: number;
  reasons: Reason[];
  missing: Reason[];
  review: Reason[];
}

/**
 * Turn an outcome signal into a bounded ordering shift.
 *
 * Every guard the owner asked for lives here, and each one FAILS SAFE towards "no shift":
 *
 *  - a signal for the wrong task kind is refused outright (no universal rank);
 *  - too few outcomes to promote, or too few to demote, yields nothing;
 *  - a single decider yields nothing (one-manager bias);
 *  - contradictory history yields nothing and asks for a human instead of picking a side.
 */
function applyLearningSignal(
  signal: SuitabilitySignal | null,
  req: CandidateRequest,
  role?: CandidateRole,
): LearningApplication {
  const reasons: Reason[] = [];
  const missing: Reason[] = [];
  const review: Reason[] = [];

  if (!signal) {
    missing.push({
      code: "no_outcome_history",
      detail: `no verified outcome history for "${req.taskKind}" — this does not count against the candidate`,
      evidence: null,
    });
    return { shift: 0, reasons, missing, review };
  }

  // A signal earned on different work says nothing about this work.
  if (signal.taskKind !== req.taskKind) {
    missing.push({
      code: "outcome_history_other_work",
      detail: `outcome history exists for "${signal.taskKind}" but not for "${req.taskKind}"; it was not applied`,
      evidence: null,
    });
    return { shift: 0, reasons, missing, review };
  }

  // NOR does a signal earned in a different ROLE (R2C). Delivering well is not advising well.
  if (role && signal.role !== role) {
    missing.push({
      code: "outcome_history_other_role",
      detail:
        `outcome history exists for the "${signal.role}" role but not for "${role}"; ` +
        `performance in one role is not evidence about another`,
      evidence: null,
    });
    return { shift: 0, reasons, missing, review };
  }

  if (signal.contradictory) {
    review.push({
      code: "contradictory_outcome_history",
      detail: "past outcomes for this work point in opposite directions; no adjustment was made and a human should judge",
      evidence: null,
    });
    return { shift: 0, reasons, missing, review };
  }

  if (signal.distinctDeciderCount < MIN_DECIDERS) {
    missing.push({
      code: "single_decider_history",
      detail: `all outcome history comes from ${signal.distinctDeciderCount} decision-maker; at least ${MIN_DECIDERS} are required before it may influence a recommendation`,
      evidence: null,
    });
    return { shift: 0, reasons, missing, review };
  }

  const delta = signal.weightedSuccessRate - BASELINE;
  const threshold = delta >= 0 ? MIN_OUTCOMES_TO_PROMOTE : MIN_OUTCOMES_TO_DEMOTE;
  if (signal.confirmedOutcomeCount < threshold) {
    missing.push({
      code: "insufficient_outcome_history",
      detail:
        `${signal.confirmedOutcomeCount} confirmed outcome(s) for "${req.taskKind}"; ` +
        `${threshold} are required before history may ${delta >= 0 ? "support" : "count against"} a candidate`,
      evidence: null,
    });
    return { shift: 0, reasons, missing, review };
  }

  const shift = clampSigned(delta * 2, 1) * MAX_LEARNING_SHIFT;
  reasons.push({
    code: delta >= 0 ? "outcome_history_supports" : "outcome_history_counts_against",
    detail:
      `${signal.confirmedOutcomeCount} confirmed outcome(s) on "${req.taskKind}" from ` +
      `${signal.distinctDeciderCount} decision-makers, ${signal.onTimeCount} completed on time ` +
      `(rule ${signal.ruleVersion})`,
    evidence: null,
  });
  return { shift, reasons, missing, review };
}

const clampSigned = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));

/**
 * Confidence in the RECOMMENDATION, not in the person.
 *
 * It rises with verified evidence and falls with gaps, so a cold-start candidate is surfaced at
 * the same rank as a proven one but with an honest, visible "we do not know much here".
 */
function computeConfidence(
  c: CandidateEvidence,
  req: CandidateRequest,
  signal: SuitabilitySignal | null,
  gapCount: number,
): number {
  let conf = 0.4; // A candidate that cleared every hard gate is already meaningfully supported.

  if (isVerified(c.capabilities)) conf += 0.15;
  if (isVerified(c.authorityLevel)) conf += 0.1;
  if (isPresent(c.available) && c.available.evidenceClass !== "stale") conf += 0.15;
  if (req.requiredVerifiedSkills.length > 0 && isVerified(c.verifiedSkills)) conf += 0.1;
  if (signal && signal.taskKind === req.taskKind && signal.confirmedOutcomeCount >= MIN_OUTCOMES_TO_PROMOTE) conf += 0.1;

  conf -= 0.05 * gapCount;
  return clamp01(Number(conf.toFixed(4)));
}

/**
 * Order candidates for human consideration.
 *
 * Ties are broken by membership id AND THEN BY ROLE, never left to sort stability. Two equal
 * candidates must produce the same order on every run and on every machine, or a "deterministic
 * rebuild" claim is untestable — and a manager who reloads must not see a different name first.
 *
 * The role tie-break closes defect R2B-F-003: one request may return the SAME person as both a
 * suggested assignee and a suggested advisor, and those two entries share a membership id, so
 * membership alone left their order decided by the order the caller happened to list the roles.
 */
export function orderCandidates<
  T extends { suitability: number; confidence: number; membershipId: string; role?: string },
>(candidates: T[]): T[] {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return [...candidates].sort((a, b) => {
    if (b.suitability !== a.suitability) return b.suitability - a.suitability;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return cmp(a.membershipId, b.membershipId) || cmp(a.role ?? "", b.role ?? "");
  });
}

/** Render provenance for the explanation surface. */
export function explainProvenance(c: CandidateEvidence): Array<{ field: string; provenance: string }> {
  return [
    { field: "capabilities", provenance: provenanceLabel(c.capabilities.evidenceClass) },
    { field: "skills", provenance: provenanceLabel(c.declaredSkills.evidenceClass) },
    { field: "verified skills", provenance: provenanceLabel(c.verifiedSkills.evidenceClass) },
    { field: "availability", provenance: provenanceLabel(c.available.evidenceClass) },
    { field: "language", provenance: provenanceLabel(c.languages.evidenceClass) },
  ];
}
