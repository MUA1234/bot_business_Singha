/**
 * Safe outcome learning (R2B checkpoint 4).
 *
 * The owner's requirement, in full: learning may use only verified completed outcomes, explicit
 * approval/rejection reasons, verified delivery quality, confirmed deadline performance,
 * documented corrections, and management-item feedback with provenance. It must influence future
 * task-specific recommendations MEASURABLY, retain evidence and rule version, support correction
 * and challenge, use minimum evidence thresholds, handle sparse and contradictory history,
 * distinguish recent from obsolete evidence, resist feedback poisoning and one-manager bias,
 * never modify authority or permissions, and never automatically discipline, reward, pay or
 * terminate anyone.
 *
 * ── Why there is no new table ────────────────────────────────────────────────────────────────
 *
 * The raw history is ALREADY append-only and durable: `management_item_transitions` (draft 002)
 * and `management_item_feedback` (draft 006) both refuse UPDATE and DELETE at the database. A
 * derived signal is a PURE FOLD over that history, so storing it would add a cache that can
 * silently disagree with the truth it was derived from. Recomputing is both cheaper to trust and
 * exactly what "reproducible and rebuildable" means. R2B therefore adds NO durable structure and
 * NO draft migration — the authorisation to create one was conditional on it being genuinely
 * necessary, and it is not.
 *
 * What IS retained is provenance: every resolution reports its `signalRuleVersion`, and the
 * existing feedback record carries the proposal it is judging, so a past recommendation can be
 * reproduced and challenged.
 *
 * ── What this module CANNOT do ───────────────────────────────────────────────────────────────
 *
 * It returns a `SuitabilitySignal` and nothing else. It has no access to authority, permissions,
 * pay or employment state, and it is consumed only by `scoreSuitability`, which caps its total
 * influence at 0.15 of an ordering value that a human then overrides at will. There is no code
 * path from an outcome to a consequence for a person.
 */
import type { SignalRole, SuitabilitySignal } from "./suitability";

/**
 * The rule version. It travels with every recommendation so a decision can be reproduced, and it
 * MUST change whenever the fold's behaviour changes — a signal you cannot attribute to a rule is
 * a signal you cannot challenge.
 */
export const SIGNAL_RULE_VERSION = "r2b.signals.1";

/**
 * One outcome, as derived from append-only history.
 *
 * `source` records which table it came from. Nothing here is authored by the kernel: an outcome
 * exists because a human moved an item to a terminal state or wrote attributed feedback.
 */
export interface OutcomeRecord {
  outcomeId: string;
  companyId: string;
  /** The person who was ACCOUNTABLE for the work. */
  membershipId: string;
  taskKind: string;
  /**
   * The ROLE they held when this happened (R2C).
   *
   * Outcomes never cross roles. Delivering a task well says nothing about the quality of
   * someone's advice, and advising well is not evidence that they should hold authority. A
   * record without a role would silently become assignee evidence for everyone.
   */
  role: SignalRole;
  itemId: string;

  /** The terminal state reached. See POLARITY for how each is treated. */
  outcome: "verified" | "reopened" | "rejected" | "dismissed";

  /** Who confirmed it. Null means unattributed, which is never eligible. */
  deciderId: string | null;
  deciderType: "user" | "system" | "ai";

  occurredAt: string;

  /** Only when a real business deadline existed (R1-D-4 forbids inventing one). */
  businessDeadline: string | null;
  /** Null when no deadline existed — NOT false. Absence of a deadline is not lateness. */
  metOnTime: boolean | null;

  /** A documented correction: this record supersedes an earlier one entirely. */
  correctsOutcomeId: string | null;

  source: "transition" | "feedback";
}

/**
 * How each terminal state is treated as evidence about a PERSON.
 *
 * `rejected` and `dismissed` are deliberately EXCLUDED. A rejected recommendation and a dismissed
 * observation are judgements about the KERNEL — a bad proposal, a noisy detector — not about the
 * person who happened to be named in them. Counting them would penalise people for the system's
 * own mistakes, and would make a manager's dismissal of a false alarm into a mark against
 * whoever was proposed. They remain valuable learning signal for detector precision and for
 * recommendation quality; they are simply not evidence about a person.
 */
const POLARITY: Record<OutcomeRecord["outcome"], 1 | -1 | 0> = {
  verified: 1,
  reopened: -1,
  rejected: 0,
  dismissed: 0,
};

/** Evidence older than this is OBSOLETE and is excluded entirely, not merely down-weighted. */
export const OBSOLETE_AFTER_DAYS = 540;
/** Recency half-life: evidence carries half the weight after this many days. */
export const HALF_LIFE_DAYS = 90;
/**
 * The most total weight any ONE decider may contribute, however many outcomes they wrote.
 * Bounds one-manager bias directly: a single enthusiastic — or hostile — manager cannot
 * outweigh everyone else by writing more.
 */
export const MAX_WEIGHT_PER_DECIDER = 3;
/**
 * At most one outcome per decider per person per day counts. This is the anti-poisoning rule: a
 * flood of records written in a burst collapses to a single day's worth of evidence, so
 * fabricating a hundred outcomes is worth no more than writing one.
 */
export const MAX_OUTCOMES_PER_DECIDER_PER_DAY = 1;
/** A verified-but-late outcome still counts as success, at reduced weight. */
const LATE_WEIGHT_MULTIPLIER = 0.5;
/**
 * Contradiction threshold. When the weaker side of the evidence holds at least this share, the
 * history genuinely disagrees with itself and NO adjustment is made.
 */
export const CONTRADICTION_SHARE = 0.3;

const DAY_MS = 86_400_000;

/**
 * Is this record admissible as evidence about a person?
 *
 * Every exclusion is one of the owner's rules, and each fails towards NOT counting.
 */
export function isAdmissible(r: OutcomeRecord, forMembershipId: string, companyId: string): boolean {
  if (r.companyId !== companyId) return false;            // never learn across companies
  if (r.membershipId !== forMembershipId) return false;
  if (POLARITY[r.outcome] === 0) return false;            // a judgement about the kernel, not the person
  if (r.deciderType !== "user") return false;             // AI- and system-authored are not verification
  if (!r.deciderId) return false;                         // unattributed feedback is not evidence
  if (r.deciderId === r.membershipId) return false;       // nobody verifies their own outcome
  return true;
}

interface Weighted {
  record: OutcomeRecord;
  weight: number;
  polarity: 1 | -1;
}

/**
 * Build the task-specific signal for one person.
 *
 * PURE and TOTAL: same records in, same signal out, on any machine and in any order. That is what
 * makes "deterministic rebuild" testable rather than asserted.
 */
export function buildSignal(
  records: readonly OutcomeRecord[],
  membershipId: string,
  taskKind: string,
  companyId: string,
  now: Date,
  /** The role being asked about. Outcomes earned in another role are not evidence here. */
  role: SignalRole = "assignee",
): SuitabilitySignal | null {
  // ── Documented corrections supersede what they correct, entirely. A corrected outcome must
  //    never be counted alongside its correction, or a mistake becomes two data points.
  const superseded = new Set<string>();
  for (const r of records) if (r.correctsOutcomeId) superseded.add(r.correctsOutcomeId);

  const relevant = records
    .filter((r) => !superseded.has(r.outcomeId))
    .filter((r) => r.taskKind === taskKind)
    .filter((r) => r.role === role)
    .filter((r) => isAdmissible(r, membershipId, companyId))
    // Deterministic order: by time, then by id, so ties never depend on input order.
    .sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? (a.outcomeId < b.outcomeId ? -1 : a.outcomeId > b.outcomeId ? 1 : 0)
        : (a.occurredAt < b.occurredAt ? -1 : 1),
    );

  if (relevant.length === 0) return null;

  // ── Recency, and the obsolete cut-off.
  const weighted: Weighted[] = [];
  for (const r of relevant) {
    const t = Date.parse(r.occurredAt);
    if (!Number.isFinite(t)) continue;               // an unreadable date is not evidence
    const ageDays = (now.getTime() - t) / DAY_MS;
    if (ageDays < 0) continue;                       // a future-dated outcome is not evidence
    if (ageDays > OBSOLETE_AFTER_DAYS) continue;     // obsolete, excluded rather than faded

    const polarity = POLARITY[r.outcome] as 1 | -1;
    let weight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    if (polarity === 1 && r.metOnTime === false) weight *= LATE_WEIGHT_MULTIPLIER;
    weighted.push({ record: r, weight, polarity });
  }

  if (weighted.length === 0) return null;

  // ── Anti-poisoning: at most N outcomes per decider per day. Sorted ascending by time, so the
  //    EARLIEST record of a burst is the one that counts — an attacker cannot displace genuine
  //    history by writing more after it.
  const perDeciderDay = new Map<string, number>();
  const deBurst: Weighted[] = [];
  for (const w of weighted) {
    const day = w.record.occurredAt.slice(0, 10);
    const key = `${w.record.deciderId}|${day}`;
    const seen = perDeciderDay.get(key) ?? 0;
    if (seen >= MAX_OUTCOMES_PER_DECIDER_PER_DAY) continue;
    perDeciderDay.set(key, seen + 1);
    deBurst.push(w);
  }

  // ── One-manager bias: cap each decider's total contributed weight.
  const byDecider = new Map<string, Weighted[]>();
  for (const w of deBurst) {
    const id = w.record.deciderId!;
    const list = byDecider.get(id);
    if (list) list.push(w); else byDecider.set(id, [w]);
  }

  let positive = 0;
  let negative = 0;
  let onTimeCount = 0;
  let confirmedOutcomeCount = 0;
  let lastOutcomeAt = "";

  for (const [, list] of byDecider) {
    const total = list.reduce((s, w) => s + w.weight, 0);
    // Scale down proportionally rather than truncating the list, so WHICH outcomes a decider
    // wrote never changes by reordering — only how much their voice weighs in total.
    const scale = total > MAX_WEIGHT_PER_DECIDER ? MAX_WEIGHT_PER_DECIDER / total : 1;
    for (const w of list) {
      const weight = w.weight * scale;
      if (w.polarity === 1) positive += weight; else negative += weight;
      confirmedOutcomeCount += 1;
      if (w.record.metOnTime === true) onTimeCount += 1;
      if (w.record.occurredAt > lastOutcomeAt) lastOutcomeAt = w.record.occurredAt;
    }
  }

  const totalWeight = positive + negative;
  if (totalWeight === 0) return null;

  const weakerShare = Math.min(positive, negative) / totalWeight;
  const contradictory = weakerShare >= CONTRADICTION_SHARE;

  return {
    taskKind,
    role,
    membershipId,
    outcomeCount: relevant.length,
    confirmedOutcomeCount,
    onTimeCount,
    distinctDeciderCount: byDecider.size,
    // Rounded so a rebuild compares equal across platforms rather than by float luck.
    weightedSuccessRate: Number((positive / totalWeight).toFixed(6)),
    contradictory,
    ruleVersion: SIGNAL_RULE_VERSION,
  };
}

/**
 * Build a lookup for the resolver from a flat history.
 *
 * The company is bound HERE, once, so no call site can accidentally fold another company's
 * outcomes into a recommendation.
 */
export function signalLookupFrom(
  records: readonly OutcomeRecord[],
  companyId: string,
  now: Date,
): (membershipId: string, taskKind: string, role?: SignalRole) => SuitabilitySignal | null {
  const cache = new Map<string, SuitabilitySignal | null>();
  return (membershipId, taskKind, role: SignalRole = "assignee") => {
    const key = `${membershipId}|${taskKind}|${role}`;
    if (!cache.has(key)) {
      cache.set(key, buildSignal(records, membershipId, taskKind, companyId, now, role));
    }
    return cache.get(key)!;
  };
}

/**
 * A human-readable account of how a signal was derived, for the "challenge this" surface.
 *
 * The owner requires learning to "support correction and challenge". A manager who disagrees
 * needs to see what the system counted and what it refused to count — a number alone cannot be
 * argued with.
 */
export function explainSignal(
  records: readonly OutcomeRecord[],
  membershipId: string,
  taskKind: string,
  companyId: string,
  now: Date = new Date(),
  role: SignalRole = "assignee",
): { counted: number; excluded: Array<{ outcomeId: string; why: string }> } {
  const superseded = new Set<string>();
  for (const r of records) if (r.correctsOutcomeId) superseded.add(r.correctsOutcomeId);

  const excluded: Array<{ outcomeId: string; why: string }> = [];
  const perDeciderDay = new Map<string, number>();
  let counted = 0;

  // Same order as the fold, so burst suppression names the same records.
  const ordered = [...records].sort((a, b) =>
    a.occurredAt === b.occurredAt
      ? (a.outcomeId < b.outcomeId ? -1 : a.outcomeId > b.outcomeId ? 1 : 0)
      : (a.occurredAt < b.occurredAt ? -1 : 1),
  );

  for (const r of ordered) {
    if (r.membershipId !== membershipId) continue;
    if (superseded.has(r.outcomeId)) {
      excluded.push({ outcomeId: r.outcomeId, why: "superseded by a documented correction" });
    } else if (r.companyId !== companyId) {
      excluded.push({ outcomeId: r.outcomeId, why: "belongs to another company" });
    } else if (r.taskKind !== taskKind) {
      excluded.push({ outcomeId: r.outcomeId, why: `earned on "${r.taskKind}", not this work` });
    } else if (r.role !== role) {
      excluded.push({
        outcomeId: r.outcomeId,
        why: `earned in the "${r.role}" role, not as ${role}`,
      });
    } else if (POLARITY[r.outcome] === 0) {
      excluded.push({ outcomeId: r.outcomeId, why: `"${r.outcome}" judges the recommendation or the detector, not the person` });
    } else if (r.deciderType !== "user") {
      excluded.push({ outcomeId: r.outcomeId, why: `confirmed by ${r.deciderType}, not a person` });
    } else if (!r.deciderId) {
      excluded.push({ outcomeId: r.outcomeId, why: "unattributed — no decision-maker recorded" });
    } else if (r.deciderId === r.membershipId) {
      excluded.push({ outcomeId: r.outcomeId, why: "self-verified" });
    } else {
      // Defect R2B-F-006: this used to stop here, so a manager challenging a suggestion was told
      // "10 counted" while the fold had actually used 3 — the obsolete, future-dated and
      // burst-suppressed records were silently absent from the explanation. The time rules are
      // applied here too, so "counted" means what the fold counted.
      const t = Date.parse(r.occurredAt);
      const ageDays = Number.isFinite(t) ? (now.getTime() - t) / DAY_MS : NaN;
      if (!Number.isFinite(ageDays)) {
        excluded.push({ outcomeId: r.outcomeId, why: "its date could not be read" });
      } else if (ageDays < 0) {
        excluded.push({ outcomeId: r.outcomeId, why: "dated in the future" });
      } else if (ageDays > OBSOLETE_AFTER_DAYS) {
        excluded.push({ outcomeId: r.outcomeId, why: `older than ${OBSOLETE_AFTER_DAYS} days — obsolete` });
      } else {
        const day = r.occurredAt.slice(0, 10);
        const key = `${r.deciderId}|${day}`;
        const seen = perDeciderDay.get(key) ?? 0;
        if (seen >= MAX_OUTCOMES_PER_DECIDER_PER_DAY) {
          excluded.push({
            outcomeId: r.outcomeId,
            why: `more than ${MAX_OUTCOMES_PER_DECIDER_PER_DAY} outcome from this decision-maker on ${day}`,
          });
        } else {
          perDeciderDay.set(key, seen + 1);
          counted += 1;
        }
      }
    }
  }
  return { counted, excluded };
}
