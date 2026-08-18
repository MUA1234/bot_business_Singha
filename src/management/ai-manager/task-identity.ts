/**
 * AIM-002 — the business identity an analysis attaches to each task it proposes.
 *
 * The database computes the fingerprint (migration 0071: `task_identity_hash`, recomputed by a
 * SECURITY DEFINER trigger on every write). This module decides only WHICH BUSINESS FACTS are
 * offered to it. That separation is the security property: a model can describe work, but it cannot
 * choose, widen or forge the key that decides whether two tasks are the same work.
 *
 * The identity is deliberately DIFFERENT for the two analysis paths, because they have different
 * amounts of real identity available:
 *
 *   • WhatsApp thread analysis — the defect AIM-002 was raised for. The case idempotency key hashes
 *     the whole transcript, so every new inbound message makes a new case, the model re-detects the
 *     same follow-up, and the task was inserted again. The fix is to scope identity to the
 *     CONVERSATION (stable across messages and across cases), not to the message or the case.
 *     Two customers are two conversations, so distinct work is never merged.
 *
 *   • Manual command-centre analysis — a free-text update typed by an operator. It carries no
 *     stable target entity, so identity is scoped to the SUBMITTED CONTENT. Two different updates
 *     never merge: "call supplier" about supplier A and about supplier B on the same day are
 *     distinct work, and title text alone cannot tell them apart. This path therefore gains a
 *     narrow guarantee (the same submission cannot produce tasks twice through two different cases)
 *     rather than a broad and unsafe one.
 *
 * OCCURRENCE WINDOW. Identity includes the UTC date. The same purpose in a new window is NEW work —
 * without that, a completed task would permanently block the same work from ever being raised again
 * (the uniqueness index excludes only cancelled rows). The cost is a boundary at UTC midnight: an
 * analysis at 23:59 and one at 00:01 see different windows. That is a bounded, visible duplicate,
 * which is the direction to err in — a wrong merge silently loses work.
 *
 * WHAT THIS DOES NOT CLAIM. Exact identity only matches an identical normalised purpose. A model
 * that paraphrases its own title produces a different identity and therefore a second task. That is
 * concern (2) of migration 0071 — semantic similarity — which is advisory by design and never
 * merges anything automatically.
 *
 * WITHIN ONE ANALYSIS the rule is different, and this was a real regression: a model that returned
 * two tasks with the SAME title but different notes ("Follow up" / about the broken gate, "follow
 * UP" / about the unpaid invoice) had the second one silently absorbed into the first, and its note
 * discarded. Two proposals in one response are two pieces of work by construction — the model
 * listed them separately — so `taskIdentityPartsForPlan` gives repeats within a single analysis a
 * distinct identity. Across analyses, identical titles still deduplicate, which is the whole point.
 */

/** Mirrors the DB bounds in `create_task_deduplicated`; the migration truncates as well. */
const MAX = { sourceType: 64, sourceId: 512, purpose: 256, target: 256, window: 64 } as const;

/** The identity keys carried on each element of `p_tasks` for `create_management_case_atomic`. */
export interface TaskIdentityParts {
  source_type: string;
  source_id: string | null;
  purpose: string;
  target: string | null;
  window: string;
}

export interface AnalysisIdentity {
  sourceType: "wa_thread" | "manual_analysis";
  /** Stable across re-analysis. The conversation, or the submitted content — never the case id. */
  sourceId: string | null;
  /** UTC date, `YYYY-MM-DD`. */
  window: string;
}

/** UTC date of an instant, as `YYYY-MM-DD`. Explicit parameter so tests are not clock-dependent. */
export function occurrenceWindow(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Normalise a proposed title into a purpose. Case, surrounding and internal whitespace must not
 * make the same work look different. The database normalises again with the same rule
 * (`normalize_identity_part`), so this is alignment, not the enforcement point.
 */
export function purposeFromTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX.purpose);
}

/** Identity for a task proposed by analysis of one WhatsApp conversation. */
export function threadIdentity(conversationId: string, at?: Date): AnalysisIdentity {
  return { sourceType: "wa_thread", sourceId: conversationId.slice(0, MAX.sourceId), window: occurrenceWindow(at) };
}

/**
 * Identity for a task proposed by manual analysis. `contentKey` is the same content hash the case
 * idempotency key uses, so identity follows the submission rather than the case row.
 */
export function manualIdentity(contentKey: string, at?: Date): AnalysisIdentity {
  return { sourceType: "manual_analysis", sourceId: contentKey.slice(0, MAX.sourceId), window: occurrenceWindow(at) };
}

/**
 * Build the identity keys for one proposed task. Returns `null` for `purpose` callers must not send
 * — an empty title has no identity, and the DB treats a null purpose as "not deduplicated" rather
 * than guessing that two unnamed tasks are the same work.
 */
/**
 * Identity for EVERY task in one analysis, in order.
 *
 * Repeats of the same normalised purpose within this single response are disambiguated by ordinal,
 * so two proposals never collapse into one and lose a note. The ordinal is derived from position
 * among equal purposes, so re-running the same analysis produces the same identities and still
 * deduplicates against the first run.
 */
export function taskIdentityPartsForPlan(
  titles: string[],
  identity: AnalysisIdentity,
): (TaskIdentityParts | null)[] {
  const seen = new Map<string, number>();
  return titles.map((title) => {
    const parts = taskIdentityParts(title, identity);
    if (!parts) return null;
    const n = (seen.get(parts.purpose) ?? 0) + 1;
    seen.set(parts.purpose, n);
    if (n === 1) return parts;
    // The suffix is bounded with the purpose so the combined value still fits the DB limit.
    return { ...parts, purpose: `${parts.purpose.slice(0, MAX.purpose - 8)}#${n}` };
  });
}

export function taskIdentityParts(title: string, identity: AnalysisIdentity): TaskIdentityParts | null {
  const purpose = purposeFromTitle(title);
  if (!purpose) return null;
  return {
    source_type: identity.sourceType.slice(0, MAX.sourceType),
    source_id: identity.sourceId ? identity.sourceId.slice(0, MAX.sourceId) : null,
    purpose,
    // No target entity is asserted. The observation's free text names customers and suppliers, but
    // taking one from it would let model-written text change the identity of a task — precisely
    // what the server-computed fingerprint exists to prevent. The source scope carries the entity
    // instead: a conversation IS the customer.
    target: null,
    window: identity.window.slice(0, MAX.window),
  };
}
