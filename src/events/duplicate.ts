/**
 * Duplicate detection. Guide invariant #9 ("a duplicate event must never create a
 * duplicate task/receipt/payment") and §14 test requirements.
 *
 * Two layers:
 *  1. Hard idempotency — identical external message id / identical document bytes
 *     collide on a key/hash and are dropped upstream (see src/lib/ids.ts).
 *  2. Soft heuristic — a *different* message describing the *same* transaction
 *     (same company + amount + date + similar counterparty within a window).
 *     This never auto-merges and NEVER terminally suppresses a payment: it raises a
 *     `duplicate_reviews` row and pauses the event in a REVERSIBLE state for a person.
 *
 * Keeping those two apart is the whole point. Exact identity is deterministic and may safely stop
 * work; a similarity score is an opinion and may only ask for one. The pipeline used to blur them
 * by writing the terminal `duplicate` state from a score, so a second genuine payment to the same
 * supplier on the same day was discarded with no screen showing it and no way back.
 *
 * A feature with MISSING evidence contributes nothing and is recorded as missing. Two absent
 * counterparties are not matching counterparties; two absent dates are not date proximity.
 */
import { Money } from "@/lib/money";

export interface DuplicateCandidateInput {
  company_id: string;
  amount: string | null;
  currency: string;
  transaction_date: string | null; // YYYY-MM-DD
  counterparty_name: string | null;
}

export interface DuplicateScore {
  score: number; // 0..1
  isLikelyDuplicate: boolean;
  reasons: string[];
  /** Per-feature contribution, so a reviewer sees WHY rather than a bare number. */
  contributions: { amount: number; date: number; counterparty: number };
  /** Which evidence was actually present, and which was absent. Absent is never a match. */
  evidencePresent: string[];
  evidenceMissing: string[];
}

/**
 * Bumped whenever the rule changes, and stored on every `duplicate_reviews` row so a past decision
 * can be read against the rule that produced it.
 */
export const DUPLICATE_ALGORITHM_VERSION = "dup/v2-evidence-required";

const DAY_MS = 86_400_000;

/** Compare a new event against one existing event and score similarity. */
export function scoreDuplicate(
  candidate: DuplicateCandidateInput,
  existing: DuplicateCandidateInput,
  opts: { windowDays?: number; threshold?: number } = {},
): DuplicateScore {
  const windowDays = opts.windowDays ?? 3;
  const threshold = opts.threshold ?? 0.7;
  const reasons: string[] = [];
  let score = 0;

  const contributions = { amount: 0, date: 0, counterparty: 0 };
  const evidencePresent: string[] = [];
  const evidenceMissing: string[] = [];
  const none = (why: string): DuplicateScore => ({
    score: 0, isLikelyDuplicate: false, reasons: [why],
    contributions, evidencePresent, evidenceMissing,
  });

  if (candidate.company_id !== existing.company_id) return none("different company");

  // Amount (weight 0.5) — exact same amount + currency is the strongest single signal.
  if (!candidate.amount || !existing.amount) {
    evidenceMissing.push("amount");
  } else if (candidate.currency !== existing.currency) {
    evidenceMissing.push("comparable currency");
  } else if (Money.of(candidate.amount, candidate.currency).equals(Money.of(existing.amount, existing.currency))) {
    contributions.amount = 0.5;
    score += 0.5;
    evidencePresent.push("amount");
    reasons.push("identical amount");
  }

  // Date proximity (weight 0.3). A MISSING date is not proximity.
  if (!candidate.transaction_date || !existing.transaction_date) {
    evidenceMissing.push("transaction date");
  } else {
    const diff = Math.abs(Date.parse(candidate.transaction_date) - Date.parse(existing.transaction_date));
    if (diff <= windowDays * DAY_MS) {
      const closeness = 1 - diff / (windowDays * DAY_MS);
      contributions.date = 0.3 * closeness;
      score += contributions.date;
      evidencePresent.push("transaction date");
      reasons.push(`dates within ${windowDays} days`);
    } else {
      evidenceMissing.push("date proximity");
    }
  }

  // Counterparty similarity (weight 0.2). TWO MISSING counterparties are not a match.
  if (!candidate.counterparty_name || !existing.counterparty_name) {
    evidenceMissing.push("counterparty");
  } else {
    const sim = counterpartySimilarity(candidate.counterparty_name, existing.counterparty_name);
    if (sim > 0) {
      contributions.counterparty = 0.2 * sim;
      score += contributions.counterparty;
      evidencePresent.push("counterparty");
      reasons.push(`counterparty similarity ${sim.toFixed(2)}`);
    } else {
      evidenceMissing.push("counterparty match");
    }
  }

  const rounded = Math.min(1, Number(score.toFixed(4)));

  /**
   * EVERY feature must contribute something.
   *
   * The old rule was `score >= threshold` alone, and the arithmetic let two features carry it:
   *   * amount + same day, with NO counterparty evidence at all → 0.8 → flagged. Two legitimate
   *     payments of the same amount on one day to DIFFERENT suppliers were declared duplicates.
   *   * amount + counterparty, with NO date proximity → exactly 0.7 → flagged. Monthly rent,
   *     salaries and instalments are precisely this shape.
   * Because the flag wrote a TERMINAL state, each of those silently discarded a real payment.
   */
  const allFeaturesPresent =
    contributions.amount > 0 && contributions.date > 0 && contributions.counterparty > 0;
  if (!allFeaturesPresent && rounded >= threshold) {
    reasons.push(`not suspected: missing ${evidenceMissing.join(", ") || "corroborating evidence"}`);
  }

  return {
    score: rounded,
    isLikelyDuplicate: allFeaturesPresent && rounded >= threshold,
    reasons,
    contributions,
    evidencePresent,
    evidenceMissing,
  };
}

/** Cheap normalized token-overlap similarity in [0,1]. */
export function counterpartySimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean),
    );
  const ta = norm(a);
  const tb = norm(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return inter / union; // Jaccard
}
