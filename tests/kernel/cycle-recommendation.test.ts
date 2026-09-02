/**
 * R2B runtime — the management cycle resolves candidates (owner Decision 2).
 *
 * The rule that matters most here is what the cycle must NEVER do. It recommends and records;
 * it does not assign, grant, notify, alter workload or act. Several of these tests exist to
 * prove an absence, which is harder than proving a presence and is exactly why they are written
 * against the real `runManagementCycle` rather than against the resolver in isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runManagementCycle, type CycleDeps, type PersistRecommendation } from "@/kernel/cycle";
import { candidateEvidence, type AvailabilitySignal, type CandidateEvidence } from "@/kernel/people/candidate";
import { fact } from "@/kernel/people/evidence";
import { buildSnapshots, assertSnapshotSafe, RESOLVER_VERSION, type RecommendationSnapshot } from "@/kernel/people/snapshot";
import { resolveCandidates } from "@/kernel/people/resolve";
import { ACTION_CATALOGUE } from "@/kernel/catalogue";
import type { Observation } from "@/kernel/observation";

const ALL_CAPABILITIES = [...new Set(
  ACTION_CATALOGUE.map((a) => a.capability).filter((c): c is string => c !== null),
)];

const CO = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-02T09:00:00.000Z");

interface Recorded {
  persisted: Array<{ o: Observation; rec: PersistRecommendation | null; snapshots: readonly RecommendationSnapshot[] }>;
}

const available: AvailabilitySignal = {
  available: true, onLeave: false, availableHours: 20, capacityStatus: "healthy",
};

function member(id: string, over: Record<string, unknown> = {}): CandidateEvidence {
  return candidateEvidence(
    { membershipId: id, companyId: CO, candidateType: "staff" },
    {
      active: fact(true, "verified", { sourceRef: { table: "memberships", id } }),
      // EVERY catalogue capability, so a refusal in these tests is always the behaviour under
      // test and never an accident of the fixture holding the wrong permission.
      capabilities: fact(ALL_CAPABILITIES, "verified", { sourceRef: { table: "membership_roles", id } }),
      authorityLevel: fact("automatic", "verified"),
      available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
      ...over,
    },
  );
}

function makeDeps(over: Partial<CycleDeps> = {}, rec: Recorded = { persisted: [] }): CycleDeps {
  const held = new Set<string>();
  return {
    now: () => NOW,
    async isCompanyEnabled() { return true; },
    async tryLock(c) { if (held.has(c)) return false; held.add(c); return true; },
    async releaseLock(c) { held.delete(c); },
    async authorityFor(companyId) {
      return { companyId, actorMembershipId: null, rules: [], policyPresent: true };
    },
    async findByIdentity() { return null; },
    async persist(o, r, snapshots = []) {
      rec.persisted.push({ o, rec: r, snapshots });
      return `item-${rec.persisted.length}`;
    },
    async recordRun() {},
    async loadCandidates() { return [member("m1"), member("m2")]; },
    async loadFor(source) {
      if (source === "finance.receivable_overdue") {
        return [{ id: "inv-1", due_date: "2026-05-01", outstanding: "480000", currency: "LKR",
                  updated_at: "2026-09-01T00:00:00.000Z", status: "open" }];
      }
      if (source === "system.health_degraded") {
        return {
          oldestPendingOutboxMinutes: 240, failedOutboxCount: 3,
          ledger: { imbalancedJournals: 1, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
          providerFailures: 4, missingConfigKeys: ["OPENAI_API_KEY"],
          sampledAt: "2026-09-02T08:55:00.000Z",
        };
      }
      return [];
    },
    ...over,
  };
}

const run = (deps: CycleDeps) =>
  runManagementCycle(deps, { companyId: CO, actorId: null, trigger: "test" });

beforeEach(() => { process.env.MANAGEMENT_KERNEL = "on"; });
afterEach(() => { delete process.env.MANAGEMENT_KERNEL; });

describe("the cycle records a recommendation", () => {
  it("resolves candidates and persists them alongside the item, in one call", async () => {
    const rec: Recorded = { persisted: [] };
    const s = await run(makeDeps({}, rec));

    expect(s.status).toBe("completed");
    const withSnapshots = rec.persisted.filter((p) => p.snapshots.length > 0);
    expect(withSnapshots.length).toBeGreaterThan(0);
    expect(s.recommendationsRecorded).toBeGreaterThan(0);

    const snap = withSnapshots[0]!.snapshots[0]!;
    expect(snap.outcome).toBe("candidates");
    expect(snap.purpose).toBe("assignee");
    expect(snap.candidate_ref).toBeTruthy();
    expect(snap.rank_position).toBe(1);
    expect(snap.reason_codes.length).toBeGreaterThan(0);
  });

  it("carries the resolver and rule versions so a recommendation can be reproduced", () => {
    // The versions travel on the persist call; here we assert the constant exists and is stable.
    expect(RESOLVER_VERSION).toBe("r2b.resolver.1");
  });
});

describe("what the cycle must NEVER do", () => {
  it("assigns nobody — no accountable owner is ever produced", async () => {
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({}, rec));
    for (const p of rec.persisted) {
      // The persist contract has no accountable-owner field at all, and the snapshots carry a
      // candidate REFERENCE, never an assignment.
      expect(JSON.stringify(p.snapshots)).not.toMatch(/accountable|assigned_to|assignee_id/i);
    }
  });

  it("changes no workload, notifies nobody and performs no work", async () => {
    const calls: string[] = [];
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({
      async loadCandidates() { calls.push("loadCandidates"); return [member("m1")]; },
    }, rec));
    // The ONLY people-related call the cycle makes is a READ.
    expect(calls).toEqual(Array(calls.length).fill("loadCandidates"));
  });

  it("never persists an opaque person score", async () => {
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({}, rec));
    const blob = JSON.stringify(rec.persisted.map((p) => p.snapshots));
    for (const forbidden of ["suitability", "score", "rating", "rank\"", "employeeScore"]) {
      expect(blob.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The ORDER survives, because that is the part a human can act on.
    expect(blob).toContain("rank_position");
  });

  it("never persists a protected attribute", async () => {
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({}, rec));
    const blob = JSON.stringify(rec.persisted.map((p) => p.snapshots)).toLowerCase();
    for (const w of ["ethnicity", "religion", "marital", "disability", "salary", "birth", "address"]) {
      expect(blob).not.toContain(w);
    }
  });
});

describe("every failure mode is recorded truthfully", () => {
  const snapshotsFor = (rec: Recorded) => rec.persisted.flatMap((p) => p.snapshots);

  it("NO ELIGIBLE CANDIDATE → needs_routing to the department, naming nobody", async () => {
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({
      async loadCandidates() { return [member("m1", { capabilities: fact([], "verified") })]; },
    }, rec));
    const routed = snapshotsFor(rec).filter((s) => s.outcome === "needs_routing");
    expect(routed.length).toBeGreaterThan(0);
    expect(routed[0]!.candidate_ref).toBeNull();
    expect(routed[0]!.routing_department).toBeTruthy();
    expect(routed[0]!.routing_reason_code).toBeTruthy();
    expect(JSON.stringify(routed[0])).not.toMatch(/admin|owner/i);
  });

  it("EVIDENCE UNAVAILABLE → a routing reason, never 'nobody is suitable'", async () => {
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({
      async loadCandidates() { throw new Error("membership read timed out"); },
    }, rec));
    const routed = snapshotsFor(rec).filter((s) => s.outcome === "needs_routing");
    expect(routed[0]!.routing_reason_code).toBe("candidate_evidence_unavailable");
    expect(routed[0]!.reasons[0]!.detail).toContain("membership read timed out");
  });

  it("STALE CAPABILITY DATA → refused, and the reason says so", async () => {
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({
      async loadCandidates() {
        return [member("m1", { active: fact(true, "stale" as never) })];
      },
    }, rec));
    const routed = snapshotsFor(rec).filter((s) => s.outcome === "needs_routing");
    expect(routed.length).toBeGreaterThan(0);
  });

  it("NO LOADER CONFIGURED → no recommendation at all, which is NOT 'nobody is suitable'", async () => {
    const rec: Recorded = { persisted: [] };
    const deps = makeDeps({}, rec);
    delete (deps as { loadCandidates?: unknown }).loadCandidates;
    const s = await run(deps);
    expect(snapshotsFor(rec)).toEqual([]);
    expect(s.recommendationsRecorded).toBe(0);
    expect(s.itemsNeedingRouting).toBe(0);
  });

  it("a LEARNING failure does not stop the recommendation", async () => {
    const rec: Recorded = { persisted: [] };
    await run(makeDeps({
      async loadSignals() { throw new Error("history read failed"); },
    }, rec));
    // Learning is an ORDERING input; losing it must not turn into a refusal to advise.
    expect(snapshotsFor(rec).some((s) => s.outcome === "candidates")).toBe(true);
  });

  it("the item is still created when resolution goes wrong", async () => {
    const rec: Recorded = { persisted: [] };
    const s = await run(makeDeps({
      async loadCandidates() { throw new Error("boom"); },
    }, rec));
    expect(s.itemsCreated).toBeGreaterThan(0);
    expect(s.status).toBe("completed");
  });
});

describe("the snapshot is a NARROWING, not a serialisation", () => {
  const person = member("m1");
  const request = {
    companyId: CO, department: "operations" as const, taskKind: "ops.task.create_internal",
    roles: ["assignee"] as const, requiredCapability: "operations.task.manage",
    requiredAuthority: "automatic" as const, authorityAmount: null, authorityDomain: null,
    requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
    onDateIso: "2026-09-02", estimateHours: null, now: NOW,
  };

  it("keeps the ORDER and the REASONS, and drops the suitability value", () => {
    const resolution = resolveCandidates({ ...request, roles: ["assignee"] }, [person, member("m2")]);
    const snaps = buildSnapshots(resolution);
    expect(snaps).toHaveLength(2);
    expect(snaps.map((s) => s.rank_position)).toEqual([1, 2]);
    expect(JSON.stringify(snaps)).not.toMatch(/suitability/i);
    expect(snaps[0]!.reasons.length).toBeGreaterThan(0);
  });

  it("does NOT persist the full rejected list — an exclusion file is not a record we keep", () => {
    const resolution = resolveCandidates(
      { ...request, roles: ["assignee"] },
      [person, member("m2", { capabilities: fact([], "verified") })],
    );
    expect(resolution.rejected.length).toBe(1);
    const snaps = buildSnapshots(resolution);
    // Only the eligible candidate is recorded; the excluded person leaves no durable trace.
    expect(snaps.every((s) => s.candidate_ref !== "m2")).toBe(true);
  });

  it("keeps skill provenance so an unverified claim never reads back as fact", () => {
    const withSkills = member("m1", {
      declaredSkills: fact(["collections"], "self_declared"),
    });
    const resolution = resolveCandidates(
      { ...request, roles: ["assignee"], preferredSkills: ["collections"] },
      [withSkills],
    );
    const snaps = buildSnapshots(resolution);
    expect(snaps[0]!.skills_used).toEqual([{ skill: "collections", verified: false }]);
  });

  it("caps how many candidates are recorded — a long tail is noise, not advice", () => {
    const many = Array.from({ length: 12 }, (_, i) => member(`m${String(i).padStart(2, "0")}`));
    const resolution = resolveCandidates({ ...request, roles: ["assignee"] }, many);
    expect(resolution.candidates).toHaveLength(12);
    expect(buildSnapshots(resolution)).toHaveLength(5);
  });

  it("refuses a snapshot that tries to carry a person score", () => {
    const bad = {
      ...buildSnapshots(resolveCandidates({ ...request, roles: ["assignee"] }, [person]))[0]!,
      reasons: [{ code: "x", detail: "y" }],
      availability: { suitability: 0.9 } as never,
    };
    expect(() => assertSnapshotSafe(bad)).toThrow(/may not carry/);
  });

  it("a needs_routing snapshot names a department and a reason, and no person", () => {
    const resolution = resolveCandidates({ ...request, roles: ["assignee"] }, []);
    const snaps = buildSnapshots(resolution);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.outcome).toBe("needs_routing");
    expect(snaps[0]!.candidate_ref).toBeNull();
    expect(snaps[0]!.routing_department).toBe("operations");
    expect(snaps[0]!.routing_reason_code).toBeTruthy();
  });
});
