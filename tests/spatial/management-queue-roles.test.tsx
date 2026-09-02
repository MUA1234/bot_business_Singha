/**
 * R2C — the spatial window shows one section per resource role.
 *
 * The rule that matters most: nothing here may imply that a person has been assigned, given
 * delegated authority, or engaged. Several of these tests exist to prove an absence.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ManagementQueuePanelContent,
  type ManagementQueueData, type QueueCandidate, type QueueItem,
  type QueueRecommendation, type QueueTeamCoverage,
} from "@/components/spatial/panels/ManagementQueuePanelContent";

const candidate = (over: Partial<QueueCandidate> = {}): QueueCandidate => ({
  membershipId: "m1", displayName: "A. Perera", role: "assignee", candidateType: "staff",
  confidence: 0.82,
  availability: { available: true, onLeave: false, availableHours: 18, capacityStatus: "healthy" },
  capabilities: ["operations.task.manage"],
  skills: [{ skill: "collections", verified: false }],
  reasons: ["holds operations.task.manage"], missingInformation: [], requiresHumanReview: [],
  evidence: [{ sourceTable: "memberships", sourceId: "m1" }],
  delegation: null, engagement: null, ...over,
});

const rec = (over: Partial<QueueRecommendation> = {}): QueueRecommendation => ({
  role: "assignee", mandatory: true, outcome: "candidates", candidates: [candidate()],
  routing: null, missingInformation: [], signalRuleVersion: "r2b.signals.1", ...over,
});

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1", department: "legal", summary: "licence expiring", stage: "recommended",
  priority: "critical", confidence: 0.9,
  evidence: [{ sourceTable: "licences", sourceId: "l-1", facts: {} }],
  evidenceQuality: "sufficient", proposedAction: "legal.obligation.escalate_internal",
  requiredAuthority: "specialist_approval", accountableOwner: null, routingReason: null,
  businessDeadline: null, reviewBy: null, reviewPolicyConfigured: false, monitoringState: null,
  timeline: [], ...over,
});

const render = (it_: QueueItem) =>
  renderToString(
    <ManagementQueuePanelContent
      data={{ items: [it_], unobservedDepartments: [], completeSweep: true } as ManagementQueueData}
    />,
  ).replaceAll("<!-- -->", "");

const multiRole = (over: Partial<QueueItem> = {}) =>
  item({
    recommendations: [
      rec({ role: "assignee", mandatory: true, requirementReason: "someone must be accountable" }),
      rec({
        role: "advisor", mandatory: true, requirementReason: "this action requires specialist advice",
        candidates: [candidate({ membershipId: "m2", displayName: "B. Silva", role: "advisor" })],
      }),
      rec({
        role: "delegate", mandatory: false, outcome: "needs_routing", candidates: [],
        routing: { department: "legal", reasonCode: "no_delegation_record", detail: "no delegation exists" },
      }),
    ],
    ...over,
  });

describe("one section per role", () => {
  it("renders a separate, labelled section for each role", () => {
    const html = render(multiRole());
    expect((html.match(/data-testid="mq-role"/g) ?? []).length).toBe(3);
    expect(html).toContain('data-role="assignee"');
    expect(html).toContain('data-role="advisor"');
    expect(html).toContain('data-role="delegate"');
  });

  it("says which roles are REQUIRED and which are optional", () => {
    const html = render(multiRole());
    expect(html).toContain("required for this work");
    expect(html).toContain("optional");
  });

  it("distinguishes a blocking unfilled role from a harmless one", () => {
    const html = render(multiRole({
      recommendations: [
        rec({ role: "assignee", mandatory: true }),
        rec({
          role: "advisor", mandatory: true, outcome: "needs_routing", candidates: [],
          routing: { department: "legal", reasonCode: "x", detail: "no evidenced adviser" },
        }),
        rec({
          role: "delegate", mandatory: false, outcome: "needs_routing", candidates: [],
          routing: { department: "legal", reasonCode: "y", detail: "no delegation exists" },
        }),
      ],
    }));
    expect(html).toContain("cannot proceed as proposed until the role is filled");
    expect(html).toContain("the rest of the recommendation still stands");
  });

  it("keeps a single-role item rendering exactly as before", () => {
    const html = render(item({ recommendation: rec() }));
    expect(html).toContain('data-testid="mq-candidates"');
    expect(html).not.toContain('data-testid="mq-roles"');
  });
});

describe("team coverage is shown, including what is NOT covered", () => {
  const team: QueueTeamCoverage = {
    covered: ["operations.task.manage"], missing: ["hr.staff.manage"],
    leadMembershipId: "m1", leadReason: null, requestedMinimum: 2, understaffed: false,
  };

  it("names the capabilities nobody on the team holds", () => {
    const html = render(item({ recommendations: [rec({ role: "assignee", team })] }));
    expect(html).toContain("hr.staff.manage");
    expect(html).toContain('data-testid="mq-team-missing"');
  });

  it("says everything is covered when it genuinely is", () => {
    const html = render(item({ recommendations: [rec({ role: "assignee", team: { ...team, missing: [] } })] }));
    expect(html).toContain("everything required is covered");
  });

  it("names ONE accountable lead", () => {
    const html = render(item({ recommendations: [rec({ role: "assignee", team })] }));
    expect(html).toContain('data-testid="mq-team-lead"');
    expect(html).toContain("m1");
  });

  it("says plainly when NO lead is proposed, rather than picking one", () => {
    const html = render(item({
      recommendations: [rec({
        role: "assignee",
        team: { ...team, leadMembershipId: null, leadReason: "nobody holds operations.task.manage" },
      })],
    }));
    expect(html).toContain("nobody proposed");
    expect(html).toContain("nobody holds operations.task.manage");
  });

  it("reports an understaffed team", () => {
    const html = render(item({
      recommendations: [rec({ role: "assignee", team: { ...team, understaffed: true } })],
    }));
    expect(html).toContain("Fewer people than the 2 this work asked for");
  });
});

describe("nothing implies an assignment, a delegation or an engagement", () => {
  it("labels a proposed delegation as proposed, with scope and expiry", () => {
    const html = render(item({
      recommendations: [rec({
        role: "delegate",
        candidates: [candidate({
          role: "delegate",
          delegation: { fromMembership: "boss", domain: "legal", endsAt: "2026-12-31T00:00:00.000Z" },
        })],
      })],
    }));
    expect(html).toContain("scope legal");
    expect(html).toContain("expires 2026-12-31T00:00:00.000Z");
    expect(html).toContain("no delegation exists until a human creates one");
  });

  it("states that a consultant has no internal access and has not been contacted", () => {
    const html = render(item({
      recommendations: [rec({
        role: "external_consultant",
        candidates: [candidate({
          role: "external_consultant", candidateType: "external_consultant", capabilities: [],
          engagement: { domains: ["procurement"], endsAt: "2026-12-31" },
        })],
      })],
    }));
    expect(html).toContain("no internal access");
    expect(html).toContain("nobody has been contacted");
  });

  it("offers accept, replace, reject AND leave-unfilled, all as links", () => {
    const html = render(multiRole());
    expect(html).toContain('data-testid="mq-role-accept"');
    expect(html).toContain('data-testid="mq-role-replace"');
    expect(html).toContain('data-testid="mq-role-reject"');
    expect(html).toContain('data-testid="mq-role-leave-unfilled"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain("<button");
  });

  it("offers no ACCEPT for a role nobody filled — there is nothing to accept", () => {
    const html = render(item({
      recommendations: [rec({
        role: "advisor", outcome: "needs_routing", candidates: [],
        routing: { department: "legal", reasonCode: "x", detail: "nobody" },
      })],
    }));
    expect(html).not.toContain('data-testid="mq-role-accept"');
    expect(html).toContain('data-testid="mq-role-leave-unfilled"');
  });

  it("says outright that nobody is assigned, delegated or engaged until the human decides", () => {
    const html = render(multiRole());
    expect(html).toContain("nobody is assigned, delegated authority or engaged until you decide");
  });

  it("hides every control from a viewer who may not decide", () => {
    const html = render(multiRole({ viewerMayDecide: false }));
    expect(html).toContain('data-testid="mq-no-decision-rights"');
    expect(html).not.toContain('data-testid="mq-role-accept"');
  });
});

describe("provenance and protected attributes", () => {
  it("marks an unverified skill as an unverified claim in every role section", () => {
    const html = render(multiRole());
    expect(html).toContain("(unverified claim)");
  });

  it("renders no protected characteristic and no person score", () => {
    const html = render(multiRole()).toLowerCase();
    for (const w of ["ethnicity", "religion", "marital", "disability", "salary", "suitability", "rating"]) {
      expect(html).not.toContain(w);
    }
  });
});
