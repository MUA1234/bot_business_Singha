import { describe, it, expect } from "vitest";
import {
  V3_1_CONTRACTS_VERSION,
  DecisionPathLadder,
  type DecisionPath,
  TaskIntelligenceProfile,
  TeamFormationProposal,
  AiGuideMessage,
} from "@/schemas/v3_1";

/**
 * The V3.1 canonical contracts describe PROPOSALS ONLY. These tests prove they accept a valid payload
 * and reject the structural mistakes that would let unsafe/ambiguous AI output through — the ladder's
 * "exactly one of each rung, exactly one recommended", role-first team structure, and private-coaching
 * addressing.
 */

const rung = (over: Partial<DecisionPath>): DecisionPath => ({
  rung: "balanced",
  title: "Balanced",
  summary: "A balanced path.",
  steps: ["do the thing"],
  expectedOutcome: "the thing is done",
  tradeoffs: [],
  requiredAuthority: "manager_approval",
  risk: "medium",
  evidenceRefs: [],
  recommended: false,
  ...over,
});

const fourRungs = (): DecisionPath[] => [
  rung({ rung: "quick_and_safe", title: "Quick & Safe", risk: "low", requiredAuthority: "policy_controlled" }),
  rung({ rung: "balanced", recommended: true }),
  rung({ rung: "robust", risk: "high", requiredAuthority: "specialist_approval" }),
  rung({ rung: "strategic", risk: "high", requiredAuthority: "owner_approval" }),
];

const validLadder = () => ({
  candidateId: "cand_1",
  companyId: "co_1",
  rungs: fourRungs(),
  promptVersion: "dp@1",
  policyVersion: "pol@1",
  schemaVersion: V3_1_CONTRACTS_VERSION,
  confidence: 0.8,
  generatedAt: "2026-08-14T00:00:00Z",
});

describe("V3.1 contracts version", () => {
  it("exposes a stable version string", () => {
    expect(V3_1_CONTRACTS_VERSION).toBe("3.1.0");
  });
});

describe("DecisionPathLadder", () => {
  it("accepts a valid 4-rung ladder with exactly one recommended", () => {
    expect(DecisionPathLadder.safeParse(validLadder()).success).toBe(true);
  });

  it("rejects a ladder without exactly four rungs", () => {
    const bad = { ...validLadder(), rungs: fourRungs().slice(0, 3) };
    expect(DecisionPathLadder.safeParse(bad).success).toBe(false);
  });

  it("rejects a duplicated rung name (must contain each rung exactly once)", () => {
    const rungs = fourRungs();
    rungs[2] = rung({ rung: "balanced" }); // now two "balanced", no "robust"
    const res = DecisionPathLadder.safeParse({ ...validLadder(), rungs });
    expect(res.success).toBe(false);
  });

  it("rejects zero or multiple recommended rungs", () => {
    const none = fourRungs().map((r) => ({ ...r, recommended: false }));
    expect(DecisionPathLadder.safeParse({ ...validLadder(), rungs: none }).success).toBe(false);

    const two = fourRungs().map((r) => ({ ...r, recommended: true }));
    expect(DecisionPathLadder.safeParse({ ...validLadder(), rungs: two }).success).toBe(false);
  });

  it("rejects an out-of-range confidence", () => {
    expect(DecisionPathLadder.safeParse({ ...validLadder(), confidence: 1.5 }).success).toBe(false);
  });
});

describe("TaskIntelligenceProfile", () => {
  const valid = {
    candidateId: "cand_1",
    scope: { companyId: "co_1" },
    title: "Follow up on overdue delivery",
    brief: "Customer reports the order is late.",
    briefVersion: 1,
    sourceEventIds: ["evt_1"],
    dedupeKey: "co_1:order:123:late",
    confidence: 0.7,
    risk: "medium" as const,
    requiredAuthority: "policy_controlled" as const,
    detectedAt: "2026-08-14T00:00:00Z",
  };

  it("accepts a valid profile and defaults status to candidate", () => {
    const res = TaskIntelligenceProfile.safeParse(valid);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.status).toBe("candidate");
  });

  it("requires at least one source event (evidence-backed)", () => {
    expect(TaskIntelligenceProfile.safeParse({ ...valid, sourceEventIds: [] }).success).toBe(false);
  });

  it("requires a dedupe key (anti-duplication anchor)", () => {
    const { dedupeKey: _omit, ...withoutKey } = valid;
    expect(TaskIntelligenceProfile.safeParse(withoutKey).success).toBe(false);
  });
});

describe("TeamFormationProposal", () => {
  const req = (role: string) => ({ role });
  const valid = {
    candidateId: "cand_1",
    companyId: "co_1",
    requirements: [req("owner"), req("doer"), req("approver"), req("verifier")],
    recommendations: [],
    confidence: 0.6,
    generatedAt: "2026-08-14T00:00:00Z",
  };

  it("accepts a valid role-first team (owner + doer present)", () => {
    expect(TeamFormationProposal.safeParse(valid).success).toBe(true);
  });

  it("rejects a team missing the owner or the doer", () => {
    const noOwner = { ...valid, requirements: [req("doer"), req("approver")] };
    expect(TeamFormationProposal.safeParse(noOwner).success).toBe(false);
  });

  it("rejects a duplicated role requirement", () => {
    const dup = { ...valid, requirements: [req("owner"), req("doer"), req("doer")] };
    expect(TeamFormationProposal.safeParse(dup).success).toBe(false);
  });

  it("rejects a recommendation that targets a non-required role", () => {
    const rec = {
      role: "adviser", // not in requirements
      source: "external",
      ref: "vendor_9",
      displayName: "Acme Advisory",
      confidence: 0.5,
    };
    expect(TeamFormationProposal.safeParse({ ...valid, recommendations: [rec] }).success).toBe(false);
  });
});

describe("AiGuideMessage", () => {
  const valid = {
    taskId: "task_1",
    companyId: "co_1",
    kind: "next_action" as const,
    body: "Confirm the delivery date with the customer.",
    visibility: "task_team" as const,
    confidence: 0.75,
    promptVersion: "guide@1",
    schemaVersion: V3_1_CONTRACTS_VERSION,
    createdAt: "2026-08-14T00:00:00Z",
  };

  it("accepts a valid team-visible message", () => {
    expect(AiGuideMessage.safeParse(valid).success).toBe(true);
  });

  it("rejects a private coaching message with no named recipient", () => {
    const priv = { ...valid, visibility: "private" as const };
    expect(AiGuideMessage.safeParse(priv).success).toBe(false);
  });

  it("accepts a private coaching message addressed to a recipient", () => {
    const priv = { ...valid, visibility: "private" as const, audienceRefs: ["staff_42"] };
    expect(AiGuideMessage.safeParse(priv).success).toBe(true);
  });

  it("accepts an optional policy-routed proposedNextAction", () => {
    const withAction = {
      ...valid,
      proposedNextAction: {
        action: "escalate to supervisor",
        reason: "blocked for 2 days",
        requiredAuthority: "manager_approval" as const,
        risk: "medium" as const,
        expiresAt: "2026-08-20T00:00:00Z",
      },
    };
    expect(AiGuideMessage.safeParse(withAction).success).toBe(true);
  });
});
