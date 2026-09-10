/**
 * Turning a resolver result into the persisted recommendation snapshot (R2B, owner Decision 2).
 *
 * This is the ONLY place a `CandidateResolution` becomes something durable, and it is a
 * NARROWING, not a serialisation. The resolver holds more than may be stored, and the difference
 * is deliberate:
 *
 *   DROPPED — `suitability`. It is an ordering value for one request; persisted against a person
 *             it becomes a rating with a history, which is the universal employee rank the owner
 *             forbade. The ORDER survives as `rankPosition`, and the REASONS survive in full —
 *             those are the things a manager can actually argue with. A number cannot be argued
 *             with, only appealed against.
 *
 *   DROPPED — the full `rejected` list. Who was considered and excluded is useful in the live
 *             surface and harmful as a permanent record: a durable "excluded because overloaded"
 *             row accumulates into exactly the performance file the owner ruled out. The
 *             needs_routing snapshot keeps the AGGREGATE reason, which is what the routing
 *             decision actually rested on.
 *
 *   KEPT    — only capabilities and skills that were ACTUALLY USED, each carrying whether it was
 *             verified, so an unverified claim can never be read back as a fact.
 *
 * The company is never taken from here. It is supplied by the authorised call at the database
 * boundary, so a snapshot cannot be attributed to another company by anything in this file.
 */
import type { CandidateResolution, EligibleCandidate } from "./candidate";

/** The code version that produced a recommendation, recorded so it can be reproduced. */
export const RESOLVER_VERSION = "r2b.resolver.1";

/** One row of `management_item_recommendations`, in the shape the RPC accepts. */
export interface RecommendationSnapshot {
  purpose: "assignee" | "advisor" | "delegate" | "external_consultant";
  outcome: "candidates" | "needs_routing";
  candidate_ref: string | null;
  candidate_type: string | null;
  rank_position: number | null;
  capabilities_used: string[];
  skills_used: Array<{ skill: string; verified: boolean }>;
  availability: { available: boolean; onLeave: boolean; availableHours: number; capacityStatus: string } | null;
  confidence: number | null;
  reason_codes: string[];
  reasons: Array<{ code: string; detail: string }>;
  missing_codes: string[];
  routing_department: string | null;
  routing_reason_code: string | null;
  evidence_refs: Array<{ sourceTable: string; sourceId: string }>;
}

/** How many candidates are worth recording. Beyond this the tail is noise, not advice. */
const MAX_CANDIDATES_PERSISTED = 5;

export function buildSnapshots(resolution: CandidateResolution): RecommendationSnapshot[] {
  if (resolution.outcome === "needs_routing") {
    const routing = resolution.routing;
    if (!routing) {
      // Should be unreachable: the resolver always builds a routing reason. If it ever is
      // reached, record the honest fact rather than a plausible-looking one.
      return [{
        purpose: "assignee",
        outcome: "needs_routing",
        candidate_ref: null, candidate_type: null, rank_position: null,
        capabilities_used: [], skills_used: [], availability: null, confidence: null,
        reason_codes: ["no_routing_reason_recorded"],
        reasons: [{ code: "no_routing_reason_recorded", detail: "the resolver returned no routing reason" }],
        missing_codes: resolution.missingInformation.map((m) => m.code),
        routing_department: null, routing_reason_code: "no_routing_reason_recorded",
        evidence_refs: [],
      }];
    }
    const routed: RecommendationSnapshot = {
      purpose: "assignee",
      outcome: "needs_routing",
      candidate_ref: null, candidate_type: null, rank_position: null,
      capabilities_used: [], skills_used: [], availability: null, confidence: null,
      reason_codes: [routing.reasonCode],
      reasons: [{ code: routing.reasonCode, detail: routing.detail }],
      missing_codes: unique(resolution.missingInformation.map((m) => m.code)),
      routing_department: routing.department,
      routing_reason_code: routing.reasonCode,
      evidence_refs: [],
    };
    assertSnapshotSafe(routed);
    return [routed];
  }

  const snaps = resolution.candidates.slice(0, MAX_CANDIDATES_PERSISTED).map((c, i) => one(c, i + 1));
  // ACTUALLY CALLED. This guard existed and nothing invoked it — a check nobody runs is a
  // comment with a function signature.
  for (const s of snaps) assertSnapshotSafe(s);
  return snaps;
}

function one(c: EligibleCandidate, rankPosition: number): RecommendationSnapshot {
  return {
    purpose: c.role,
    outcome: "candidates",
    candidate_ref: c.membershipId,
    candidate_type: c.candidateType,
    rank_position: rankPosition,
    capabilities_used: [...c.relevantCapabilities],
    skills_used: c.relevantSkills.map((s) => ({ skill: s.skill, verified: s.verified })),
    availability: c.availability
      ? {
          available: c.availability.available,
          onLeave: c.availability.onLeave,
          availableHours: c.availability.availableHours,
          capacityStatus: c.availability.capacityStatus,
        }
      : null,
    confidence: c.confidence,
    reason_codes: unique(c.reasons.map((r) => r.code)),
    reasons: c.reasons.map((r) => ({ code: r.code, detail: r.detail })),
    missing_codes: unique(c.missingInformation.map((m) => m.code)),
    routing_department: null,
    routing_reason_code: null,
    evidence_refs: c.evidenceRefs.map((e) => ({ sourceTable: e.table, sourceId: e.id })),
  };
}

const unique = (xs: string[]) => [...new Set(xs)];

/**
 * Guard: nothing that could act as a person-level score may reach the snapshot.
 *
 * The database enforces this too. This exists so a mistake is caught in a unit test with a clear
 * message, rather than as a constraint violation inside a transaction three layers down.
 */
const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  "suitability", "suitabilityScore", "score", "rating", "rank", "employeeScore", "overallScore",
]);

export function assertSnapshotSafe(s: RecommendationSnapshot): void {
  for (const key of Object.keys(s)) {
    if (FORBIDDEN_SNAPSHOT_KEYS.has(key)) {
      throw new Error(`recommendation snapshot may not carry "${key}" — it would become a person-level score`);
    }
  }
  const blob = JSON.stringify(s.reasons) + JSON.stringify(s.availability ?? {}) + JSON.stringify(s.skills_used);
  for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
    if (new RegExp(`"${key}"\\s*:`, "i").test(blob)) {
      throw new Error(`recommendation snapshot payload may not carry "${key}"`);
    }
  }
}
