/**
 * Evidence provenance for people intelligence (R2B).
 *
 * The owner's rule is absolute: *"Do not treat inferred or self-declared information as
 * verified."* This module makes that rule STRUCTURAL rather than a convention — every input to
 * candidate resolution is a {@link Fact}, and a Fact cannot be read without also reading how it
 * was obtained. There is no way to pass a bare `string[]` of skills into the resolver.
 *
 * The classes are the owner's six, and only `verified` satisfies a mandatory requirement:
 *
 *   verified        a system-of-record row, or a recorded human decision with a decider and a
 *                   timestamp (membership, capability, approved leave, an append-only outcome)
 *   manager_entered a manager typed it; nobody checked it against a document or an authority
 *   self_declared   the person stated it about themselves
 *   inferred        computed from other data (availability, capacity) — true only as of a moment
 *   stale           it WAS one of the above, but its as-of time is outside the freshness window
 *   absent          no source exists at all
 *
 * `stale` is deliberately a class rather than a flag: the dependency audit found that
 * `capacity_snapshots` is weekly, so a capacity reading is routinely a few days old and
 * occasionally a month old, and those two cases must not be indistinguishable to the resolver.
 */

export type EvidenceClass =
  | "verified"
  | "manager_entered"
  | "self_declared"
  | "inferred"
  | "stale"
  | "absent";

export const EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  "verified", "manager_entered", "self_declared", "inferred", "stale", "absent",
] as const;

/**
 * A value together with its provenance.
 *
 * `value` is null whenever the class is `absent`. It may ALSO be null for any other class —
 * a verified source can verifiably hold nothing — so callers must never infer the class from
 * the value, which is precisely why both are always present.
 */
export interface Fact<T> {
  readonly value: T | null;
  readonly evidenceClass: EvidenceClass;
  /** When the underlying record was last known good. Null when unknown or absent. */
  readonly asOf: string | null;
  /** The row this came from, for the evidence trail shown to the human. */
  readonly sourceRef: { table: string; id: string } | null;
}

/** The honest answer when no source exists. Never fabricate a value to fill a gap. */
export function absent<T>(): Fact<T> {
  return { value: null, evidenceClass: "absent", asOf: null, sourceRef: null };
}

export function fact<T>(
  value: T | null,
  evidenceClass: Exclude<EvidenceClass, "absent">,
  opts: { asOf?: string | null; sourceRef?: { table: string; id: string } | null } = {},
): Fact<T> {
  return {
    value,
    evidenceClass,
    asOf: opts.asOf ?? null,
    sourceRef: opts.sourceRef ?? null,
  };
}

/**
 * ONLY `verified` satisfies a mandatory requirement. This is the single predicate the
 * eligibility gates consult, so widening what counts as verified is a one-line, reviewable
 * change rather than a search through the codebase.
 */
export function isVerified<T>(f: Fact<T>): boolean {
  return f.evidenceClass === "verified" && f.value !== null;
}

/** Is there any usable value at all, regardless of how well attested? */
export function isPresent<T>(f: Fact<T>): boolean {
  return f.evidenceClass !== "absent" && f.value !== null;
}

/**
 * Re-class a fact as `stale` when its as-of time is older than the freshness window.
 *
 * A fact with NO as-of time is NOT silently treated as fresh — that would let an undated row
 * masquerade as current. It keeps its class and is reported through `missingInformation`
 * instead, so the human sees "we do not know how old this is" rather than nothing.
 */
export function withFreshness<T>(f: Fact<T>, now: Date, maxAgeMs: number): Fact<T> {
  if (f.evidenceClass === "absent" || f.evidenceClass === "stale") return f;
  if (!f.asOf) return f;
  const t = Date.parse(f.asOf);
  if (!Number.isFinite(t)) return f;
  if (now.getTime() - t > maxAgeMs) return { ...f, evidenceClass: "stale" };
  return f;
}

/** Capacity is snapshotted weekly (migration 0013), so anything older than 8 days is stale. */
export const CAPACITY_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * A human-readable provenance note for the explanation UI. The owner requires the
 * recommendation to be explainable, and "she has the skill" is not explainable when nobody
 * ever checked. This renders the difference.
 */
export function provenanceLabel(c: EvidenceClass): string {
  switch (c) {
    case "verified": return "verified";
    case "manager_entered": return "entered by a manager, not verified";
    case "self_declared": return "self-declared, not verified";
    case "inferred": return "inferred from other records";
    case "stale": return "out of date";
    case "absent": return "not recorded";
  }
}
